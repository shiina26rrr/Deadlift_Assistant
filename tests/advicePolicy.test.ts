import { describe, expect, it } from 'vitest'
import { ADVICE_CATALOG, select } from '@renderer/analysis/advicePolicy'
import type {
  AdviceConfig,
  AdviceInput,
  CandidateIssue,
  PredictionSummary
} from '@shared/types'

const config: AdviceConfig = { policyVersion: 'advice-1', maxItems: 3, minCoverage: 0.5 }

function issue(ruleId: string, duration: number, overrides: Partial<CandidateIssue> = {}): CandidateIssue {
  return {
    ruleId,
    stage: 'PULLING',
    dependentMetrics: ['elbowInnerAngle'],
    params: {},
    duration,
    source: '测试规则来源',
    validationStatus: 'PENDING',
    feedbackText: `${ruleId} 观察`,
    ...overrides
  }
}

function input(overrides: Partial<AdviceInput> = {}): AdviceInput {
  return {
    perMetricCoverage: { armGround: 0.9, elbowInner: 0.9, kneeInner: 0.9, trunkLean: 0.9 },
    validCoverageRatio: 0.9,
    candidateIssues: [],
    proportion: null,
    framingQualityHints: [],
    ...overrides
  }
}

describe('ADVICE_CATALOG', () => {
  it('adviceId 唯一，且文案不含合格线/医学结论', () => {
    const ids = ADVICE_CATALOG.map((e) => e.adviceId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of ADVICE_CATALOG) {
      expect(entry.text).not.toMatch(/合格|不合格|医学|诊断|标准分/)
    }
  })
})

describe('select 建议策略', () => {
  it('有效观察达到证据门槛时输出规则建议并标注来源', () => {
    const s = select(input({ candidateIssues: [issue('elbow-bend', 400)] }), null, config)
    expect(s.policyVersion).toBe('advice-1')
    expect(s.items).toHaveLength(1)
    expect(s.items[0].adviceId).toBe('elbow-bend')
    expect(s.items[0].source).toBe('rule-policy')
    expect(s.items[0].evidence).toContain('累计 0.4s')
    expect(s.fallbackReason).toBeUndefined()
  })

  it('证据时长不足门槛时不输出该建议（不凑数）', () => {
    const s = select(input({ candidateIssues: [issue('elbow-bend', 200)] }), null, config)
    expect(s.items.map((i) => i.adviceId)).toEqual(['neutral-no-issue'])
    expect(s.fallbackReason).toBe('NO_EVIDENCE')
  })

  it('同一规则多条候选项按累计时长合并后判定门槛', () => {
    const s = select(
      input({ candidateIssues: [issue('elbow-bend', 200), issue('elbow-bend', 250)] }),
      null,
      config
    )
    expect(s.items.map((i) => i.adviceId)).toEqual(['elbow-bend'])
    expect(s.items[0].evidence).toContain('累计 0.5s')
  })

  it('依赖指标覆盖率低于门槛时不输出该建议', () => {
    const s = select(
      input({
        candidateIssues: [issue('elbow-bend', 500)],
        perMetricCoverage: { armGround: 0.9, elbowInner: 0.2, kneeInner: 0.9, trunkLean: 0.9 }
      }),
      null,
      config
    )
    // 肘覆盖率过低 → 规则项被门槛拒绝，仅剩机位调整提示
    expect(s.items.map((i) => i.adviceId)).toEqual(['camera-adjust'])
  })

  it('总覆盖率不足时优先给出机位调整提示并标记数据不足', () => {
    const s = select(
      input({ validCoverageRatio: 0.2, candidateIssues: [issue('elbow-bend', 500)] }),
      null,
      config
    )
    expect(s.items[0].adviceId).toBe('camera-adjust')
    expect(s.fallbackReason).toBe('DATA_INSUFFICIENT')
  })

  it('入框质量提示触发机位调整提示', () => {
    const s = select(input({ framingQualityHints: ['脚踝出画'] }), null, config)
    expect(s.items[0].adviceId).toBe('camera-adjust')
    expect(s.items[0].evidence).toContain('脚踝出画')
  })

  it('机位提示不否定其他指标的可信观察，可同时给出', () => {
    const s = select(
      input({
        perMetricCoverage: { armGround: 0.1, elbowInner: 0.9, kneeInner: 0.9, trunkLean: 0.9 },
        candidateIssues: [issue('elbow-bend', 500)]
      }),
      null,
      config
    )
    expect(s.items.map((i) => i.adviceId)).toEqual(['camera-adjust', 'elbow-bend'])
    expect(s.items[0].kind).toBe('quality')
    expect(s.items[1].kind).toBe('rule-observation')
  })

  it('多指标观察必须全部达到覆盖率门槛，不能用最高值代替', () => {
    const s = select(
      input({
        perMetricCoverage: { armGround: 0.9, elbowInner: 0.2, kneeInner: 0.9, trunkLean: 0.9 },
        candidateIssues: [
          issue('shoulder-hip-async', 500, {
            dependentMetrics: ['armGroundAngle', 'elbowInnerAngle']
          })
        ]
      }),
      null,
      config
    )
    expect(s.items.map((i) => i.adviceId)).not.toContain('shoulder-hip-async')
  })

  it('总覆盖率不足时仍保留依赖指标达标的独立观察', () => {
    const s = select(
      input({ validCoverageRatio: 0.2, candidateIssues: [issue('elbow-bend', 500)] }),
      null,
      config
    )
    expect(s.items.map((i) => i.adviceId)).toEqual(['camera-adjust', 'elbow-bend'])
    expect(s.fallbackReason).toBe('DATA_INSUFFICIENT')
  })

  it('中性提示标记为 neutral，不参与动作问题判定', () => {
    const s = select(input(), null, config)
    expect(s.items[0].kind).toBe('neutral')
  })

  it('无有效观察时返回中性提示且不声称动作标准', () => {
    const s = select(input(), null, config)
    expect(s.items[0].adviceId).toBe('neutral-no-issue')
    expect(s.items[0].text).toContain('教练指导')
    expect(s.items[0].text).not.toMatch(/不合格|合格线|标准分/)
    expect(s.fallbackReason).toBe('NO_EVIDENCE')
  })

  it('条数不超过上限，且上限被强制收敛到 3 以内', () => {
    const multi = input({
      candidateIssues: [
        issue('elbow-bend', 500),
        issue('arm-deviation', 500, { dependentMetrics: ['armGroundAngle'] }),
        issue('shoulder-hip-async', 500)
      ]
    })
    expect(select(multi, null, { ...config, maxItems: 99 }).items.length).toBeLessThanOrEqual(3)
    expect(select(multi, null, { ...config, maxItems: 1 }).items).toHaveLength(1)
  })

  it('模型参考不绕过门槛，也不凭空生成问题', () => {
    const model: PredictionSummary = {
      available: true,
      modelVersion: 'm1',
      predictedClass: 'PB',
      rejected: false
    }
    // 无候选 + 有模型：仍是中性提示，不因模型输出问题
    const s = select(input(), model, config)
    expect(s.items.map((i) => i.adviceId)).toEqual(['neutral-no-issue'])
    // 证据不足项即便有模型也不输出
    const s2 = select(input({ candidateIssues: [issue('elbow-bend', 150)] }), model, config)
    expect(s2.items.map((i) => i.adviceId)).not.toContain('elbow-bend')
  })

  it('拒判模型不影响结论', () => {
    const rejected: PredictionSummary = {
      available: true,
      modelVersion: 'm1',
      rejected: true,
      reason: 'LOW_CONFIDENCE'
    }
    const s = select(input({ candidateIssues: [issue('elbow-bend', 500)] }), rejected, config)
    expect(s.items.map((i) => i.adviceId)).toEqual(['elbow-bend'])
  })
})
