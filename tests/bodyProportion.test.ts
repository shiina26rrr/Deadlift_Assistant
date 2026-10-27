import { describe, expect, it } from 'vitest'
import { estimate } from '@renderer/analysis/bodyProportion'
import type { CredibleStandingFrame, Point2D, ProportionConfig } from '@shared/types'

const config: ProportionConfig = {
  windowMs: 3000,
  minValidFrames: 12,
  maxDispersion: 0.08,
  minSegmentConfidence: 10
}

interface Segments {
  thigh?: number
  shin?: number
  trunk?: number
  upperArm?: number
  forearm?: number
  omitKnee?: boolean
}

/** 构造可信站立帧（原始像素坐标）；沿 y 轴摆放腿/躯干，沿 x 轴摆放手臂。 */
function frame(segments: Segments, side: 'left' | 'right' = 'right'): CredibleStandingFrame {
  const { thigh = 110, shin = 100, trunk = 140, upperArm = 70, forearm = 60, omitKnee = false } = segments
  const idx = { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28 }
  const ankleY = 0
  const kneeY = -shin
  const hipY = -shin - thigh
  const shoulderY = hipY - trunk
  const points: Point2D[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0 }))
  points[idx.ankle] = { x: 0, y: ankleY }
  if (!omitKnee) points[idx.knee] = { x: 0, y: kneeY }
  points[idx.hip] = { x: 0, y: hipY }
  points[idx.shoulder] = { x: 0, y: shoulderY }
  points[idx.elbow] = { x: upperArm, y: shoulderY }
  points[idx.wrist] = { x: upperArm + forearm, y: shoulderY }
  return { keypoints: points, side, timestamp: 0 }
}

function repeat(f: CredibleStandingFrame, n: number): CredibleStandingFrame[] {
  return Array.from({ length: n }, (_, i) => ({ ...f, timestamp: i * 33 }))
}

describe('estimate 身体比例', () => {
  it('一致的多帧给出 OK 与正确中位数比例', () => {
    const est = estimate(repeat(frame({}), 20), config)
    expect(est.quality).toBe('OK')
    expect(est.validFrames).toBe(20)
    expect(est.featureVersion).toBe('prop-1')
    expect(est.ratios.thighToShin).toBeCloseTo(1.1, 3)
    expect(est.ratios.trunkToLeg).toBeCloseTo(140 / 210, 3)
    expect(est.ratios.armToTrunk).toBeCloseTo(130 / 140, 3)
    expect(est.dispersion).toBeCloseTo(0, 5)
  })

  it('有效帧数不足时降级为 LOW', () => {
    const est = estimate(repeat(frame({}), 3), config)
    expect(est.validFrames).toBe(3)
    expect(est.quality).toBe('LOW')
  })

  it('离散度过大时降级为 LOW（保留中位数）', () => {
    const frames = [
      ...repeat(frame({ thigh: 110, shin: 100 }), 10),
      ...repeat(frame({ thigh: 300, shin: 100 }), 10)
    ]
    const est = estimate(frames, config)
    expect(est.quality).toBe('LOW')
    expect(est.ratios.thighToShin).toBeCloseTo(2.0, 1)
    expect(est.dispersion).toBeGreaterThan(config.maxDispersion)
  })

  it('无帧时缺失项为 null 且质量 MISSING', () => {
    const est = estimate([], config)
    expect(est.quality).toBe('MISSING')
    expect(est.validFrames).toBe(0)
    expect(est.ratios).toEqual({ thighToShin: null, trunkToLeg: null, armToTrunk: null })
  })

  it('关键点不足时对应比例为 null，不猜测', () => {
    const est = estimate(repeat(frame({ omitKnee: true }), 20), config)
    expect(est.ratios.thighToShin).toBeNull()
    expect(est.ratios.trunkToLeg).toBeNull()
    // 手臂比例仍可计算（不因腿缺失而污染）
    expect(est.ratios.armToTrunk).toBeCloseTo(130 / 140, 3)
  })

  it('分段过短（近零分母）不参与比例计算', () => {
    const est = estimate(repeat(frame({ shin: 1 }), 20), config)
    expect(est.ratios.thighToShin).toBeNull()
  })
})
