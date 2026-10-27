import { describe, expect, it } from 'vitest'
import { calibrate } from '@renderer/analysis/calibration'
import type { CalibrationConfig, CalibrationFrame, Point2D } from '@shared/types'
import { pixelPoints } from './helpers'

const config: CalibrationConfig = { durationMs: 2500, stabilityThreshold: 6, minConfidence: 0.5 }

function standingKeypoints(): Point2D[] {
  const pts = pixelPoints()
  pts[11] = { x: 100, y: 50, visibility: 0.9 }
  pts[13] = { x: 100, y: 100, visibility: 0.9 }
  pts[15] = { x: 100, y: 150, visibility: 0.9 }
  pts[23] = { x: 100, y: 200, visibility: 0.9 }
  pts[25] = { x: 100, y: 250, visibility: 0.9 }
  pts[27] = { x: 100, y: 300, visibility: 0.9 }
  return pts
}

function makeFrames(
  count: number,
  stepMs = 500,
  keypointsFn: () => Point2D[] = standingKeypoints
): CalibrationFrame[] {
  return Array.from({ length: count }, (_, i) => ({
    keypoints: keypointsFn(),
    timestamp: i * stepMs
  }))
}

describe('calibrate 站立校准', () => {
  it('稳定站立帧序列校准成功', () => {
    const frames = makeFrames(6)
    const result = calibrate(frames, 'left', config)
    expect(result.success).toBe(true)
    expect(result.reference).toBeDefined()
    expect(result.reference!.side).toBe('left')
    expect(result.reference!.standingAngles.kneeInnerAngle.value).toBeCloseTo(180)
    expect(result.reference!.standingAngles.trunkLeanAngle.value).toBeCloseTo(0)
    expect(result.reference!.standingAngles.armGroundAngle.value).toBeCloseTo(90)
  })

  it('采集时长不足时失败', () => {
    const frames = makeFrames(3)
    const result = calibrate(frames, 'left', config)
    expect(result.success).toBe(false)
    expect(result.reason).toContain('采集时长不足')
  })

  it('无帧时失败', () => {
    const result = calibrate([], 'left', config)
    expect(result.success).toBe(false)
    expect(result.reason).toContain('未采集到站立帧')
  })

  it('膝盖明显屈曲时失败', () => {
    const frames = makeFrames(6, 500, () => {
      const pts = standingKeypoints()
      pts[25] = { x: 120, y: 220, visibility: 0.9 }
      return pts
    })
    const result = calibrate(frames, 'left', config)
    expect(result.success).toBe(false)
    expect(result.reason).toContain('膝盖明显屈曲')
  })

  it('躯干前倾较大时失败', () => {
    const frames = makeFrames(6, 500, () => {
      const pts = standingKeypoints()
      pts[11] = { x: 180, y: 120, visibility: 0.9 }
      return pts
    })
    const result = calibrate(frames, 'left', config)
    expect(result.success).toBe(false)
    expect(result.reason).toContain('并非站立')
  })
})
