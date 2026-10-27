import { describe, expect, it } from 'vitest'
import { buildUserPrompt, checkConsistency } from '../src/main/polishGuard'
import type { AnonymousSummary } from '@shared/types'

function summary(overrides: Partial<AnonymousSummary> = {}): AnonymousSummary {
  return {
    completedCount: 5,
    durationSec: 12,
    validCoveragePercent: 80,
    dataSufficient: true,
    angleRanges: {
      armGround: { min: 85, max: 90, valid: true },
      elbowInner: { min: 0, max: 0, valid: false },
      kneeInner: { min: 170, max: 178, valid: true },
      trunkLean: { min: 0, max: 0, valid: false }
    },
    suggestions: [
      {
        text: '本组部分指标有效数据不足：请先调整机位后再评价动作。',
        evidence: '依据：肘内角、躯干倾角；本组有效覆盖率 80.0%',
        relatedIssues: ['camera-adjust']
      }
    ],
    ...overrides
  }
}

describe('buildUserPrompt', () => {
  it('无效范围写"不可用"，不把空范围写成 0–0°', () => {
    const prompt = buildUserPrompt(summary())
    expect(prompt).toContain('肘内角 不可用')
    expect(prompt).toContain('躯干倾角 不可用')
    expect(prompt).not.toContain('肘内角 0–0°')
    expect(prompt).toContain('手臂夹角 85–90°')
  })

  it('只包含筛选后的建议，不包含候选问题列表', () => {
    const prompt = buildUserPrompt(summary())
    expect(prompt).toContain('内置建议')
    expect(prompt).not.toContain('候选观察')
  })

  it('数据不足时明确不做动作评价', () => {
    const prompt = buildUserPrompt(summary({ dataSufficient: false }))
    expect(prompt).toContain('不给出动作评价')
  })
})

describe('checkConsistency', () => {
  it('接受保留次数、时长、覆盖率且数值均来自摘要的润色', () => {
    const text = '本组完成 5 次，时长 12.0 秒，有效覆盖率 80%。部分指标不可用，建议调整机位。'
    expect(checkConsistency(text, summary())).toBe(true)
  })

  it('拒绝改动数值', () => {
    const text = '本组完成 5 次，时长 13.0 秒，有效覆盖率 80%。'
    expect(checkConsistency(text, summary())).toBe(false)
  })

  it('拒绝引入摘要之外的新数值', () => {
    const text = '本组完成 5 次，时长 12.0 秒，有效覆盖率 80%，建议做 3 组。'
    expect(checkConsistency(text, summary())).toBe(false)
  })

  it('拒绝把无效范围写成 0° 观测值', () => {
    const text = '本组完成 5 次，时长 12.0 秒，有效覆盖率 80%，肘内角 0°。'
    expect(checkConsistency(text, summary())).toBe(false)
  })

  it('拒绝缺少完成次数或覆盖率的文本', () => {
    expect(checkConsistency('时长 12.0 秒，有效覆盖率 80%。', summary())).toBe(false)
    expect(checkConsistency('本组完成 5 次，时长 12.0 秒。', summary())).toBe(false)
  })

  it('拒绝医学/安全结论', () => {
    const text = '本组完成 5 次，时长 12.0 秒，有效覆盖率 80%，这样练不会受伤。'
    expect(checkConsistency(text, summary())).toBe(false)
  })

  it('拒绝把动作表述为标准', () => {
    const text = '本组完成 5 次，时长 12.0 秒，有效覆盖率 80%，动作标准。'
    expect(checkConsistency(text, summary())).toBe(false)
  })

  it('数据不足时拒绝声称数据充足', () => {
    const text = '本组完成 5 次，时长 12.0 秒，有效覆盖率 80%，数据充足。'
    expect(checkConsistency(text, summary({ dataSufficient: false }))).toBe(false)
  })
})
