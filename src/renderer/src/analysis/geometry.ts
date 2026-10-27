// 二维姿态几何：自行编写的向量与角度计算，不依赖大模型。
// 约定：先按 x×width、y×height 将归一化坐标还原为像素坐标，再做几何计算，
// 避免宽高比造成角度失真；画布缩放/留白/镜像不影响此处结果。
import type {
  AngleEntry,
  AngleSet,
  Displacement,
  FrameSize,
  NormalizedLandmark,
  Point2D,
  Side
} from '@shared/types'

const EPS = 1e-6
export const DEFAULT_MIN_CONFIDENCE = 0.5

export interface SideLandmarkIndex {
  shoulder: number
  elbow: number
  wrist: number
  hip: number
  knee: number
  ankle: number
}

/** MediaPipe Pose 的 33 关键点索引（仅取侧面分析所需肢体）。 */
export const LANDMARK_INDEX: Record<Side, SideLandmarkIndex> = {
  left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28 }
}

export interface Vec2 {
  x: number
  y: number
}

const unavailable = (): AngleEntry => ({ value: 0, validity: 'UNAVAILABLE' })

const entry = (value: number, min: number, max: number): AngleEntry => {
  if (!Number.isFinite(value)) return unavailable()
  if (value < min - 1e-3 || value > max + 1e-3) return unavailable()
  return { value, validity: 'VALID' }
}

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
const len = (v: Vec2): number => Math.hypot(v.x, v.y)

/** 向量夹角（度，0–180）。零长度向量返回 NaN。 */
export function angleBetween(v1: Vec2, v2: Vec2): number {
  const m1 = len(v1)
  const m2 = len(v2)
  if (m1 < EPS || m2 < EPS) return Number.NaN
  let cos = (v1.x * v2.x + v1.y * v2.y) / (m1 * m2)
  cos = Math.max(-1, Math.min(1, cos))
  return (Math.acos(cos) * 180) / Math.PI
}

/** 在顶点 b 处，由 b→a 与 b→c 构成的内角（度，0–180）。 */
export function angleAt(a: Vec2, b: Vec2, c: Vec2): number {
  return angleBetween(sub(a, b), sub(c, b))
}

/** 归一化坐标 → 像素坐标（x×width，y×height）。 */
export function restorePixels(landmarks: NormalizedLandmark[], frameSize: FrameSize): Point2D[] {
  return landmarks.map((p) => ({
    x: p.x * frameSize.width,
    y: p.y * frameSize.height,
    visibility: p.visibility ?? 0
  }))
}

function visible(p: Point2D | undefined, minConfidence: number): boolean {
  return !!p && p.visibility >= minConfidence && Number.isFinite(p.x) && Number.isFinite(p.y)
}

/** 手臂与画面水平线的锐角（0–90°）；接近垂直为接近 90°。 */
export function armGroundAngle(shoulder: Vec2, wrist: Vec2): number {
  const v = sub(wrist, shoulder)
  return (Math.atan2(Math.abs(v.y), Math.abs(v.x)) * 180) / Math.PI
}

/** 躯干（髋→肩）与画面竖直线的夹角（0–90°）；站直约为 0°。它不是腰椎弯曲角。 */
export function trunkLeanAngle(hip: Vec2, shoulder: Vec2): number {
  const v = sub(shoulder, hip)
  return (Math.atan2(Math.abs(v.x), Math.abs(v.y)) * 180) / Math.PI
}

/** 由像素坐标点计算四项角度。 */
export function computeAnglesFromPixels(
  points: Point2D[],
  side: Side,
  minConfidence = DEFAULT_MIN_CONFIDENCE
): AngleSet {
  const idx = LANDMARK_INDEX[side]
  const shoulder = points[idx.shoulder]
  const elbow = points[idx.elbow]
  const wrist = points[idx.wrist]
  const hip = points[idx.hip]
  const knee = points[idx.knee]
  const ankle = points[idx.ankle]

  const armVecLen = Math.hypot(wrist.x - shoulder.x, wrist.y - shoulder.y)
  const trunkVecLen = Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y)

  const armValid =
    visible(shoulder, minConfidence) && visible(wrist, minConfidence) && armVecLen > EPS
  const elbowValid =
    visible(shoulder, minConfidence) && visible(elbow, minConfidence) && visible(wrist, minConfidence)
  const kneeValid =
    visible(hip, minConfidence) && visible(knee, minConfidence) && visible(ankle, minConfidence)
  const trunkValid =
    visible(hip, minConfidence) && visible(shoulder, minConfidence) && trunkVecLen > EPS

  return {
    armGroundAngle: armValid
      ? entry(armGroundAngle(shoulder, wrist), 0, 90)
      : unavailable(),
    elbowInnerAngle: elbowValid
      ? entry(angleAt(shoulder, elbow, wrist), 0, 180)
      : unavailable(),
    kneeInnerAngle: kneeValid ? entry(angleAt(hip, knee, ankle), 0, 180) : unavailable(),
    trunkLeanAngle: trunkValid ? entry(trunkLeanAngle(hip, shoulder), 0, 90) : unavailable()
  }
}

/** 归一化关键点 → 四项角度（内部完成像素还原）。 */
export function computeAngles(
  landmarks: NormalizedLandmark[],
  side: Side,
  frameSize: FrameSize,
  minConfidence = DEFAULT_MIN_CONFIDENCE
): AngleSet {
  return computeAnglesFromPixels(restorePixels(landmarks, frameSize), side, minConfidence)
}

/** 该侧 6 个关键点的平均置信度，用于可见侧选择。 */
export function sideConfidence(landmarks: NormalizedLandmark[], side: Side): number {
  const idx = LANDMARK_INDEX[side]
  const keys = [idx.shoulder, idx.elbow, idx.wrist, idx.hip, idx.knee, idx.ankle]
  let sum = 0
  for (const k of keys) sum += landmarks[k]?.visibility ?? 0
  return sum / keys.length
}

/** 归一化坐标下肩/髋相对参考位置的垂直位移（正值表示向下）。 */
export function computeDisplacement(
  reference: { shoulderY: number; hipY: number },
  current: { shoulderY: number; hipY: number }
): Displacement {
  return {
    shoulderDelta: current.shoulderY - reference.shoulderY,
    hipDelta: current.hipY - reference.hipY,
    normalized: true
  }
}

/** 四项角度是否全部可用。 */
export function allAnglesValid(set: AngleSet): boolean {
  return (
    set.armGroundAngle.validity === 'VALID' &&
    set.elbowInnerAngle.validity === 'VALID' &&
    set.kneeInnerAngle.validity === 'VALID' &&
    set.trunkLeanAngle.validity === 'VALID'
  )
}
