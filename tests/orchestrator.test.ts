import { describe, expect, it } from 'vitest'
import { AnalysisOrchestrator } from '@renderer/analysis/orchestrator'
import { cloneDefaultConfig } from '@shared/config'
import type { NormalizedLandmark } from '@shared/types'
import { makeStandingLandmarks } from './helpers'

const FRAME = { width: 100, height: 100 }

function makeOrchestrator(): AnalysisOrchestrator {
  return new AnalysisOrchestrator(cloneDefaultConfig(), () => undefined)
}

function makeManualSideOrchestrator(): AnalysisOrchestrator {
  const config = cloneDefaultConfig()
  config.side.manualSide = 'left'
  return new AnalysisOrchestrator(config, () => undefined)
}

/** 按固定步长喂入 count 帧相同关键点，返回下一帧时间戳。 */
function feed(
  orchestrator: AnalysisOrchestrator,
  landmarks: NormalizedLandmark[],
  startTs: number,
  count: number,
  step = 100
): number {
  let ts = startTs
  for (let i = 0; i < count; i += 1) {
    orchestrator.processFrame(landmarks, FRAME, ts)
    ts += step
  }
  return ts
}

/** 站立关键点（左侧，躯干竖直、膝伸直）。 */
const standing = (): NormalizedLandmark[] => makeStandingLandmarks()
/** 明显前倾关键点（肩前移，躯干倾角 > 12°）。 */
const leaning = (): NormalizedLandmark[] => makeStandingLandmarks({ 11: { x: 0.75, y: 0.3 } })
/** 全部关键点不可见（持续喂入 > 过期时限后进入数据不足）。 */
const hidden = (): NormalizedLandmark[] => {
  const arr: NormalizedLandmark[] = []
  for (let i = 0; i < 33; i += 1) arr.push({ x: 0.5, y: 0.5, z: 0, visibility: 0 })
  return arr
}

/** 站立稳定 → 前倾起拉 → 稳定站直，完成一次动作。返回下一帧时间戳。 */
function performOneRep(orchestrator: AnalysisOrchestrator, startTs: number): number {
  let ts = feed(orchestrator, standing(), startTs, 7) // IDLE→READY（readyStableMs=500）
  ts = feed(orchestrator, leaning(), ts, 6) // READY→PULLING 并保持
  return feed(orchestrator, standing(), ts, 10) // PULLING→STANDING（standStableMs=400）
}

/** 从站直下放并回到准备（STANDING→LOWERING→READY）。 */
function lowerToReady(orchestrator: AnalysisOrchestrator, startTs: number): number {
  let ts = feed(orchestrator, leaning(), startTs, 8)
  return feed(orchestrator, standing(), ts, 12)
}

describe('AnalysisOrchestrator 动作分段（SegmentedAction）', () => {
  it('完成一次动作产出 1 个分段，字段与训练契约一致', () => {
    const o = makeOrchestrator()
    o.begin(0)
    performOneRep(o, 0)

    const actions = o.segmentedActions
    expect(actions.length).toBe(1)
    const a = actions[0]
    expect(a.index).toBe(1)
    expect(a.side).toBe('left')
    expect(a.endMs).toBeGreaterThan(a.startMs)
    expect(a.frames.length).toBeGreaterThan(0)
    expect(a.validRatio).toBe(1)
    // 位移按身高代理归一化（此处肩/髋竖直位置不变 → 0）。
    expect(a.displacement.shoulder).toBeCloseTo(0)
    expect(a.displacement.hip).toBeCloseTo(0)
  })

  it('完成两次动作产出两个递增序号的分段', () => {
    const o = makeOrchestrator()
    o.begin(0)
    let ts = performOneRep(o, 0)
    ts = lowerToReady(o, ts)
    ts = feed(o, leaning(), ts, 6)
    feed(o, standing(), ts, 10)

    expect(o.segmentedActions.map((a) => a.index)).toEqual([1, 2])
  })

  it('起拉中途数据不足（未达站直）不产出分段，也不计次', () => {
    const o = makeOrchestrator()
    o.begin(0)
    let ts = feed(o, standing(), 0, 7)
    ts = feed(o, leaning(), ts, 3) // 进入 PULLING
    feed(o, hidden(), ts, 9) // 起拉中持续不可见 → DATA_INSUFFICIENT

    expect(o.segmentedActions.length).toBe(0)
    expect(o.countRecord.completedCount).toBe(0)
  })

  it('reset 清空已积累的分段', () => {
    const o = makeOrchestrator()
    o.begin(0)
    performOneRep(o, 0)
    expect(o.segmentedActions.length).toBe(1)
    o.reset()
    expect(o.segmentedActions.length).toBe(0)
  })
})

describe('AnalysisOrchestrator 指标范围独立统计', () => {
  it('髋点不可见导致阶段数据无效时，仍保留手臂/肘的有效角度范围', () => {
    const o = makeManualSideOrchestrator()
    o.begin(0)
    // 仅隐藏左髋：手臂与肘仍有效，膝与躯干不可用。
    feed(o, makeStandingLandmarks({ 23: { visibility: 0 } }), 0, 10)

    const data = o.end()
    expect(data.validCoverageRatio).toBe(0)
    expect(data.angleRanges.armGround.valid).toBe(true)
    expect(data.angleRanges.elbowInner.valid).toBe(true)
    expect(data.angleRanges.kneeInner.valid).toBe(false)
    expect(data.angleRanges.trunkLean.valid).toBe(false)
    expect(data.perMetricCoverage.armGround).toBeCloseTo(1)
    expect(data.perMetricCoverage.kneeInner).toBe(0)
  })
})

describe('AnalysisOrchestrator 校准产出身体比例参考', () => {
  it('校准成功后附带从校准窗口估计的比例参考', () => {
    const o = makeOrchestrator()
    o.beginCalibration()
    feed(o, standing(), 0, 27) // 覆盖 >= durationMs(2500) 的站立帧
    const result = o.endCalibration()

    expect(result.success).toBe(true)
    expect(result.proportion).toBeDefined()
    const estimate = result.proportion!.estimate
    expect(estimate.featureVersion).toBe('prop-1')
    // 等腰关键点 → 三段比例均为 1，质量 OK。
    expect(estimate.ratios.thighToShin).toBeCloseTo(1)
    expect(estimate.ratios.trunkToLeg).toBeCloseTo(1)
    expect(estimate.quality).toBe('OK')
  })
})
