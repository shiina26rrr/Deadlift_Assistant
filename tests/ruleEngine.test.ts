import { describe, expect, it } from 'vitest'
import { evaluateFrame, RuleEngine } from '@renderer/analysis/ruleEngine'
import type { RuleConfig } from '@shared/types'
import { angleEntry, makeAngleSet, makeFeatures } from './helpers'

const config: RuleConfig = {
  elbowBendThreshold: 150,
  elbowBendMinDurationMs: 300,
  armDeviationThreshold: 25,
  armDeviationMinDurationMs: 400,
  enableShoulderHipCheck: false,
  shoulderHipAsyncThreshold: 0.05
}

function activeRule(ruleId: string, phase: 'READY' | 'PULLING' | 'STANDING', angles: Parameters<typeof makeAngleSet>[0]): boolean {
  const result = evaluateFrame(makeFeatures({ angles: makeAngleSet(angles) }), phase, config)
  return result.find((r) => r.ruleId === ruleId)?.active ?? false
}

describe('evaluateFrame 规则触发条件', () => {
  it('起拉期间明显弯肘触发', () => {
    expect(activeRule('elbow-bend', 'PULLING', { elbowInnerAngle: angleEntry(120) })).toBe(true)
  })

  it('肘接近伸直不触发', () => {
    expect(activeRule('elbow-bend', 'PULLING', { elbowInnerAngle: angleEntry(170) })).toBe(false)
  })

  it('非起拉阶段不触发', () => {
    expect(activeRule('elbow-bend', 'READY', { elbowInnerAngle: angleEntry(120) })).toBe(false)
  })

  it('手臂方向明显偏离垂直触发（辅助观察）', () => {
    expect(activeRule('arm-deviation', 'PULLING', { armGroundAngle: angleEntry(40) })).toBe(true)
    expect(activeRule('arm-deviation', 'PULLING', { armGroundAngle: angleEntry(80) })).toBe(false)
  })

  it('肩髋不协调默认关闭', () => {
    const result = evaluateFrame(makeFeatures(), 'PULLING', config, { shoulderY: 0.3, hipY: 0.6 })
    expect(result.find((r) => r.ruleId === 'shoulder-hip-async')?.active).toBe(false)
  })

  it('不可用角度不触发规则', () => {
    expect(activeRule('elbow-bend', 'PULLING', { elbowInnerAngle: angleEntry(0, 'UNAVAILABLE') })).toBe(false)
  })
})

describe('RuleEngine 累计触发时长', () => {
  const bend = (ts: number) =>
    makeFeatures({ timestamp: ts, angles: makeAngleSet({ elbowInnerAngle: angleEntry(120) }) })

  it('累计达到最短时长后输出候选问题（含规则元数据）', () => {
    const engine = new RuleEngine()
    for (const ts of [0, 100, 200, 300, 400]) engine.update(bend(ts), 'PULLING', config)
    const issue = engine.getIssues(config).find((i) => i.ruleId === 'elbow-bend')
    expect(issue).toBeDefined()
    expect(issue?.duration).toBeGreaterThanOrEqual(300)
    expect(issue?.validationStatus).toBe('PENDING')
    expect(issue?.source.length).toBeGreaterThan(0)
  })

  it('低于最短时长不输出', () => {
    const engine = new RuleEngine()
    engine.update(bend(0), 'PULLING', config)
    engine.update(bend(100), 'PULLING', config)
    expect(engine.getIssues(config).find((i) => i.ruleId === 'elbow-bend')).toBeUndefined()
  })

  it('reset 清空累计状态', () => {
    const engine = new RuleEngine()
    for (const ts of [0, 100, 200, 300, 400]) engine.update(bend(ts), 'PULLING', config)
    engine.reset()
    expect(engine.getIssues(config)).toHaveLength(0)
  })
})
