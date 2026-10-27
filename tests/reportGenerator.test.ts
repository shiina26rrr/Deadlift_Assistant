import { describe, expect, it } from 'vitest'
import { aggregateAngleRanges, generate } from '@renderer/analysis/reportGenerator'
import { createEmptyCountRecord } from '@renderer/analysis/counter'
import type {
  AdviceConfig,
  CandidateIssue,
  PredictionSummary,
  ReportConfig,
  SessionData
} from '@shared/types'
import { angleEntry, makeAngleSet } from './helpers'

const config: ReportConfig = { minCoverageForEvaluation: 0.5, maxSuggestions: 3 }
const adviceConfig: AdviceConfig = { policyVersion: 'advice-1', maxItems: 3, minCoverage: 0.5 }

function issue(ruleId: string, duration: number): CandidateIssue {
  return {
    ruleId,
    stage: 'PULLING',
    dependentMetrics: ['elbowInnerAngle'],
    params: {},
    duration,
    source: '规则来源（测试）',
    validationStatus: 'PENDING',
    feedbackText: `${ruleId} 观察`
  }
}

function session(overrides: Partial<SessionData> = {}): SessionData {
  return {
    countRecord: { ...createEmptyCountRecord(), completedCount: 3, actionTimestamps: [1000, 2000, 3000] },
    durationSec: 12,
    validCoverageRatio: 0.8,
    angleRanges: aggregateAngleRanges([makeAngleSet()]),
    actionIntervals: [1000, 1000],
    candidateIssues: [],
    perRepEvidence: [],
    perMetricCoverage: { armGround: 0.9, elbowInner: 0.9, kneeInner: 0.8, trunkLean: 0.8 },
    ...overrides
  }
}

describe('aggregateAngleRanges', () => {
  it('汇总有效角度变化范围', () => {
    const ranges = aggregateAngleRanges([
      makeAngleSet({ trunkLeanAngle: angleEntry(5) }),
      makeAngleSet({ trunkLeanAngle: angleEntry(40) })
    ])
    expect(ranges.trunkLean.min).toBeCloseTo(5)
    expect(ranges.trunkLean.max).toBeCloseTo(40)
    expect(ranges.trunkLean.valid).toBe(true)
  })

  it('无有效样本时 valid=false', () => {
    const ranges = aggregateAngleRanges([makeAngleSet({ trunkLeanAngle: angleEntry(0, 'UNAVAILABLE') })])
    expect(ranges.trunkLean.valid).toBe(false)
  })
})

describe('generate 整组报告', () => {
  it('覆盖率充足且有候选问题时输出建议', () => {
    const report = generate(
      session({ candidateIssues: [issue('elbow-bend', 400), issue('arm-deviation', 500)] }),
      config
    )
    expect(report.dataSufficient).toBe(true)
    expect(report.suggestions.length).toBe(2)
    // 按时长降序，最长者优先
    expect(report.suggestions[0].relatedIssues).toEqual(['arm-deviation'])
  })

  it('覆盖率不足时减少评价并标记数据不足', () => {
    const report = generate(
      session({ validCoverageRatio: 0.2, candidateIssues: [issue('elbow-bend', 400)] }),
      config
    )
    expect(report.dataSufficient).toBe(false)
    expect(report.suggestions.length).toBe(0)
    expect(report.validCoveragePercent).toBeCloseTo(20)
  })

  it('无候选问题时给出中性提示而非"动作标准"', () => {
    const report = generate(session(), config)
    expect(report.dataSufficient).toBe(true)
    expect(report.suggestions.length).toBe(1)
    expect(report.suggestions[0].text).toContain('未检测到')
  })

  it('建议数量不超过配置上限', () => {
    const issues = [issue('a', 1), issue('b', 2), issue('c', 3), issue('d', 4)]
    const report = generate(session({ candidateIssues: issues }), {
      minCoverageForEvaluation: 0.5,
      maxSuggestions: 2
    })
    expect(report.suggestions.length).toBe(2)
  })
})

describe('generate v3：建议策略与模型分区', () => {
  it('提供 adviceConfig 时走建议策略链路并写入策略版本', () => {
    const report = generate(session({ candidateIssues: [issue('elbow-bend', 400)] }), config, {
      adviceConfig,
      model: null
    })
    expect(report.advicePolicyVersion).toBe('advice-1')
    expect(report.suggestions[0].relatedIssues).toEqual(['elbow-bend'])
    expect(report.suggestions[0].evidence).toContain('累计 0.4s')
  })

  it('无模型时"本地动作模型参考"分区明确标注仅规则分析', () => {
    const report = generate(session(), config, { adviceConfig, model: null })
    expect(report.modelReference).toBeDefined()
    expect(report.modelReference?.available).toBe(false)
    expect(report.modelReference?.note).toContain('仅作规则分析')
  })

  it('模型预测 GB 与几何规则观察冲突时标记 conflictWithRules', () => {
    const model: PredictionSummary = {
      available: true,
      modelVersion: 'm1',
      predictedClass: 'GB',
      rejected: false
    }
    const report = generate(session({ candidateIssues: [issue('elbow-bend', 400)] }), config, {
      adviceConfig,
      model
    })
    expect(report.modelReference?.conflictWithRules).toBe(true)
    expect(report.modelReference?.rejected).toBe(false)
  })

  it('中性建议不算规则问题：模型 GB 时不标记冲突', () => {
    const model: PredictionSummary = {
      available: true,
      modelVersion: 'm1',
      predictedClass: 'GB',
      rejected: false
    }
    const report = generate(session(), config, { adviceConfig, model })
    expect(report.suggestions[0].relatedIssues).toEqual(['neutral-no-issue'])
    expect(report.modelReference?.conflictWithRules).toBe(false)
  })

  it('仅数据质量提示不算动作问题：模型 GB 时不标记冲突', () => {
    const model: PredictionSummary = {
      available: true,
      modelVersion: 'm1',
      predictedClass: 'GB',
      rejected: false
    }
    const report = generate(
      session({ perMetricCoverage: { armGround: 0.1, elbowInner: 0.9, kneeInner: 0.9, trunkLean: 0.9 } }),
      config,
      { adviceConfig, model }
    )
    expect(report.suggestions.map((s) => s.relatedIssues[0])).toContain('camera-adjust')
    expect(report.modelReference?.conflictWithRules).toBe(false)
  })

  it('模型拒判时分区标注拒判原因', () => {
    const model: PredictionSummary = {
      available: true,
      modelVersion: 'm1',
      rejected: true,
      reason: 'LOW_CONFIDENCE'
    }
    const report = generate(session(), config, { adviceConfig, model })
    expect(report.modelReference?.rejected).toBe(true)
    expect(report.modelReference?.note).toContain('仅作规则分析')
  })

  it('组内模式不一致时标注 MIXED_PATTERN 并给出类别分布，不归为单一错误', () => {
    const model: PredictionSummary = {
      available: true,
      modelVersion: 'm1',
      rejected: true,
      reason: 'MIXED_PATTERN',
      classDistribution: { GB: 0.5, PB: 0, LLK: 0.5 }
    }
    const report = generate(session(), config, { adviceConfig, model })
    expect(report.modelReference?.rejected).toBe(true)
    expect(report.modelReference?.reason).toBe('MIXED_PATTERN')
    expect(report.modelReference?.note).toContain('模式不一致')
    expect(report.modelReference?.note).toContain('GB 50%')
    expect(report.modelReference?.note).toContain('LLK 50%')
    expect(report.modelReference?.classDistribution).toEqual({ GB: 0.5, PB: 0, LLK: 0.5 })
  })

  it('接受时在说明中附类别占比', () => {
    const model: PredictionSummary = {
      available: true,
      modelVersion: 'm1',
      predictedClass: 'GB',
      rejected: false,
      classDistribution: { GB: 1, PB: 0, LLK: 0 }
    }
    const report = generate(session(), config, { adviceConfig, model })
    expect(report.modelReference?.note).toContain('GB 100%')
  })

  it('未传 options 时保持 v2 兼容行为（无策略版本与模型分区）', () => {
    const report = generate(session({ candidateIssues: [issue('elbow-bend', 400)] }), config)
    expect(report.advicePolicyVersion).toBeUndefined()
    expect(report.modelReference).toBeUndefined()
    expect(report.suggestions[0].relatedIssues).toEqual(['elbow-bend'])
  })
})
