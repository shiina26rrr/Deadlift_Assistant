import { describe, expect, it } from 'vitest'
import {
  allAnglesValid,
  angleAt,
  armGroundAngle,
  computeAngles,
  restorePixels,
  sideConfidence,
  trunkLeanAngle
} from '@renderer/analysis/geometry'
import { makeLandmarks, makeStandingLandmarks } from './helpers'

describe('向量与内角基本约定', () => {
  it('直角内角为 90°', () => {
    expect(angleAt({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 })).toBeCloseTo(90, 5)
  })

  it('共线内角为 180°', () => {
    expect(angleAt({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 })).toBeCloseTo(180, 5)
  })

  it('零长度向量返回 NaN', () => {
    expect(Number.isNaN(angleAt({ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 2 }))).toBe(true)
  })
})

describe('手臂与地面夹角 / 躯干倾角', () => {
  it('垂直手臂接近 90°', () => {
    expect(armGroundAngle({ x: 0, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(90, 5)
  })

  it('水平手臂接近 0°', () => {
    expect(armGroundAngle({ x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(0, 5)
  })

  it('站立躯干接近 0°', () => {
    expect(trunkLeanAngle({ x: 0, y: 10 }, { x: 0, y: 0 })).toBeCloseTo(0, 5)
  })
})

describe('归一化坐标还原', () => {
  it('按 x×width、y×height 还原为像素坐标', () => {
    const points = restorePixels([{ x: 0.5, y: 0.25, z: 0, visibility: 0.9 }], {
      width: 1920,
      height: 1080
    })
    expect(points[0].x).toBeCloseTo(960)
    expect(points[0].y).toBeCloseTo(270)
  })
})

describe('四项角度计算', () => {
  it('正方形画面对齐关键点得到 90/180/180/0', () => {
    const angles = computeAngles(makeStandingLandmarks(), 'left', { width: 1000, height: 1000 })
    expect(angles.armGroundAngle.value).toBeCloseTo(90, 1)
    expect(angles.elbowInnerAngle.value).toBeCloseTo(180, 1)
    expect(angles.kneeInnerAngle.value).toBeCloseTo(180, 1)
    expect(angles.trunkLeanAngle.value).toBeCloseTo(0, 1)
    expect(allAnglesValid(angles)).toBe(true)
  })

  it('非正方形画面不造成角度失真（先还原像素再计算）', () => {
    const landmarks = makeLandmarks({
      11: { x: 0.4, y: 0.4 },
      13: { x: 0.45, y: 0.45 },
      15: { x: 0.5, y: 0.5 },
      23: { x: 0.5, y: 0.6 },
      25: { x: 0.5, y: 0.75 },
      27: { x: 0.5, y: 0.9 }
    })
    // 像素坐标：肩(400,200) 腕(500,250) → dx=100 dy=50 → atan2(50,100)=26.57°
    const angles = computeAngles(landmarks, 'left', { width: 1000, height: 500 })
    expect(angles.armGroundAngle.value).toBeCloseTo(26.57, 1)
    expect(angles.armGroundAngle.value).not.toBeCloseTo(45, 0)
  })

  it('零长度向量返回不可用', () => {
    const landmarks = makeLandmarks({
      11: { x: 0.5, y: 0.5 },
      13: { x: 0.5, y: 0.5 },
      15: { x: 0.5, y: 0.5 },
      23: { x: 0.5, y: 0.6 },
      25: { x: 0.5, y: 0.7 },
      27: { x: 0.5, y: 0.8 }
    })
    const angles = computeAngles(landmarks, 'left', { width: 1000, height: 1000 })
    expect(angles.armGroundAngle.validity).toBe('UNAVAILABLE')
    expect(angles.elbowInnerAngle.validity).toBe('UNAVAILABLE')
  })

  it('置信度不足返回不可用', () => {
    const landmarks = makeLandmarks({
      11: { x: 0.5, y: 0.3, visibility: 0.1 },
      15: { x: 0.5, y: 0.6, visibility: 0.1 }
    })
    const angles = computeAngles(landmarks, 'left', { width: 1000, height: 1000 }, 0.5)
    expect(angles.armGroundAngle.validity).toBe('UNAVAILABLE')
  })
})

describe('可见侧置信度', () => {
  it('返回该侧 6 个关键点的平均置信度', () => {
    const landmarks = makeLandmarks({
      11: { x: 0.5, y: 0.3, visibility: 1 },
      13: { x: 0.5, y: 0.4, visibility: 1 },
      15: { x: 0.5, y: 0.5, visibility: 1 },
      23: { x: 0.5, y: 0.6, visibility: 1 },
      25: { x: 0.5, y: 0.7, visibility: 1 },
      27: { x: 0.5, y: 0.8, visibility: 1 }
    })
    expect(sideConfidence(landmarks, 'left')).toBeCloseTo(1, 5)
    expect(sideConfidence(landmarks, 'right')).toBeGreaterThan(0)
  })
})
