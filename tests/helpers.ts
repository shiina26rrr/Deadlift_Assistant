import type { AngleEntry, AngleSet, NormalizedLandmark, Point2D } from '@shared/types'
import type { FrameFeatures } from '@renderer/analysis/types'

/**
 * 构造 33 个关键点：默认全部可见（visibility 0.9），可按键值覆盖。
 * 关键点索引遵循 MediaPipe Pose 约定。
 */
export function makeLandmarks(
  overrides: Record<number, Partial<NormalizedLandmark>> = {}
): NormalizedLandmark[] {
  const arr: NormalizedLandmark[] = []
  for (let i = 0; i < 33; i += 1) {
    arr.push({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 })
  }
  for (const [key, value] of Object.entries(overrides)) {
    const index = Number(key)
    arr[index] = { ...arr[index], ...value }
  }
  return arr
}

export function angleEntry(value: number, validity: AngleEntry['validity'] = 'VALID'): AngleEntry {
  return { value, validity }
}

export function makeAngleSet(overrides: Partial<AngleSet> = {}): AngleSet {
  return {
    armGroundAngle: angleEntry(90),
    elbowInnerAngle: angleEntry(175),
    kneeInnerAngle: angleEntry(175),
    trunkLeanAngle: angleEntry(5),
    ...overrides
  }
}

export function makeFeatures(overrides: Partial<FrameFeatures> = {}): FrameFeatures {
  return {
    timestamp: 0,
    side: 'left',
    angles: makeAngleSet(),
    valid: true,
    shoulderNorm: { x: 0.5, y: 0.3 },
    hipNorm: { x: 0.5, y: 0.6 },
    ...overrides
  }
}

/** 标准侧面对齐的关键点（左侧），frameSize 为正方形时四角为 0/90/180。 */
export function makeStandingLandmarks(
  overrides: Record<number, Partial<NormalizedLandmark>> = {}
): NormalizedLandmark[] {
  return makeLandmarks({
    11: { x: 0.5, y: 0.3 }, // 左肩
    13: { x: 0.5, y: 0.45 }, // 左肘
    15: { x: 0.5, y: 0.6 }, // 左腕
    23: { x: 0.5, y: 0.6 }, // 左髋
    25: { x: 0.5, y: 0.75 }, // 左膝
    27: { x: 0.5, y: 0.9 }, // 左踝
    ...overrides
  })
}

export function pixelPoints(count = 33): Point2D[] {
  return Array.from({ length: count }, () => ({ x: 100, y: 100, visibility: 0.9 }))
}
