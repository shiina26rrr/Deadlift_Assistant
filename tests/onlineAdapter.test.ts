import { describe, expect, it } from 'vitest'
import { buildAnonymousSummary, buildVoiceSummary } from '@renderer/analysis/onlineAdapter'
import type { CandidateIssue, GroupReport } from '@shared/types'

function issue(ruleId: string, feedbackText: string): CandidateIssue {
  return {
    ruleId,
    stage: 'PULLING',
    dependentMetrics: ['elbowInnerAngle'],
    params: {},
    duration: 500,
    source: '测试规则来源',
    validationStatus: 'PENDING',
    feedbackText
  }
}

function report(overrides: Partial<GroupReport> = {}): GroupReport {
  return {
    completedCount: 5,
    incompleteSegments: [],
    durationSec: 12,
    validCoveragePercent: 80,
    angleRanges: {
      armGround: { min: 85, max: 90, valid: true },
      elbowInner: { min: 0, max: 0, valid: false },
      kneeInner: { min: 170, max: 178, valid: true },
      trunkLean: { min: 0, max: 0, valid: false }
    },
    rhythm: [2000],
    candidateIssues: [issue('elbow-bend', '未经筛选的候选观察')],
    suggestions: [
      {
        text: '本组部分指标有效数据不足：请先调整机位后再评价动作。',
        evidence: '依据：肘内角、躯干倾角；本组有效覆盖率 80.0%',
        relatedIssues: ['camera-adjust']
      }
    ],
    dataSufficient: true,
    perMetricCoveragePercent: { armGround: 90, elbowInner: 10, kneeInner: 80, trunkLean: 20 },
    ...overrides
  }
}

describe('buildAnonymousSummary', () => {
  it('只发送筛选后的建议，不发送未入选候选问题', () => {
    const summary = buildAnonymousSummary(report())
    expect('candidateIssues' in summary).toBe(false)
    expect(summary.suggestions.map((s) => s.relatedIssues[0])).toEqual(['camera-adjust'])
    expect(summary.dataSufficient).toBe(true)
  })
})

describe('buildVoiceSummary', () => {
  it('数据不足时只播报数据不足，不读候选问题', () => {
    const text = buildVoiceSummary(report({ dataSufficient: false }))
    expect(text).toContain('有效数据不足')
    expect(text).not.toContain('未经筛选的候选观察')
  })

  it('使用筛选后的建议，而不是 candidateIssues[0]', () => {
    const text = buildVoiceSummary(report())
    expect(text).toContain('调整机位')
    expect(text).not.toContain('未经筛选的候选观察')
  })

  it('仅有中性建议时播报未检测到明显观察项', () => {
    const text = buildVoiceSummary(
      report({
        candidateIssues: [],
        suggestions: [
          {
            text: '本组未检测到需要改进的启发式观察项。',
            evidence: '未触发任何启发式规则。',
            relatedIssues: ['neutral-no-issue']
          }
        ]
      })
    )
    expect(text).toContain('未检测到明显观察项')
  })
})
