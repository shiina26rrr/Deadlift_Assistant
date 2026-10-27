// 入框引导与人体位置检测（v3）：纯几何判定，不参与测量坐标。
// 摄像头开场要求至少头部至脚踝完整入框，满足后才进入校准与倒计时。
// 引导框为固定竖向框，仅作显示引导；判定基于归一化关键点坐标（0–1）相对完整画面。
// 头部点不是头顶测量，用 headMargin 上移鼻点估计头顶边界（鼻点在框内 ≠ 头部完整）。
import type {
  FramingBox,
  FramingConfig,
  FramingState,
  FramingStatus,
  NormalizedLandmark,
  Side
} from '@shared/types'
import { LANDMARK_INDEX } from './geometry'

/** MediaPipe Pose 鼻点索引。 */
const NOSE_INDEX = 0

/** 各状态对应的框上方中文提示（给出具体调整方向，不只变色）。 */
export const FRAMING_MESSAGE: Record<FramingStatus, string> = {
  UNDETECTED: '未检测到人：请站在画面中，确保全身入镜',
  HEAD_OUT: '头部出画：请后退一点，让头部和脚踝进入框内',
  ANKLE_OUT: '脚踝出画：请后退一点，让头部和脚踝进入框内',
  TOO_CLOSE: '距离过近：请后退一点，让全身进入框内',
  SHIFT_LEFT: '偏左：请向右移动到引导框中央',
  SHIFT_RIGHT: '偏右：请向左移动到引导框中央',
  UNCERTAIN: '关键点不足，无法确认入框状态：请调整机位或保持完整可见',
  READY: '已完整入框，可开始校准'
}

/** 固定竖向引导框（归一化，相对完整画面）。 */
export function framingBox(config: FramingConfig): FramingBox {
  const width = clamp01(config.boxWidthRatio)
  const top = clamp01(config.boxMarginTop)
  const bottom = clamp01(config.boxMarginBottom)
  const height = Math.max(0, 1 - top - bottom)
  return { x: (1 - width) / 2, y: top, width, height }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}

function visible(p: NormalizedLandmark | undefined, minConfidence: number): boolean {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && (p.visibility ?? 0) >= minConfidence
}

/** 该侧判定所需的关键点索引（鼻点 + 肩、髋、膝、踝）。 */
function requiredIndices(side: Side): number[] {
  const idx = LANDMARK_INDEX[side]
  return [NOSE_INDEX, idx.shoulder, idx.hip, idx.knee, idx.ankle]
}

function meanVisibility(landmarks: NormalizedLandmark[], indices: number[]): number {
  let sum = 0
  for (const i of indices) sum += landmarks[i]?.visibility ?? 0
  return sum / indices.length
}

function state(status: FramingStatus, box: FramingBox, humanBox: FramingBox | null): FramingState {
  return { status, ready: status === 'READY', box, message: FRAMING_MESSAGE[status], humanBox }
}

/**
 * 判定人体入框状态。frameSize 不参与判定（landmarks 已是归一化坐标），
 * 保留参数以便渲染层理解坐标含义与后向兼容。
 */
export function evaluate(
  landmarks: NormalizedLandmark[],
  config: FramingConfig,
  _frameSize?: { width: number; height: number }
): FramingState {
  const box = framingBox(config)
  if (!landmarks || landmarks.length === 0) {
    return state('UNDETECTED', box, null)
  }

  const leftIdx = requiredIndices('left')
  const rightIdx = requiredIndices('right')
  const leftVis = meanVisibility(landmarks, leftIdx)
  const rightVis = meanVisibility(landmarks, rightIdx)

  // 两侧关键点均不可见：未检测到人。
  if (leftVis < config.minConfidence && rightVis < config.minConfidence) {
    return state('UNDETECTED', box, null)
  }

  const side: Side = rightVis > leftVis ? 'right' : 'left'
  const indices = requiredIndices(side)
  // 关键点不足：无法确认，不猜测身体包围框。
  if (indices.some((i) => !visible(landmarks[i], config.minConfidence))) {
    return state('UNCERTAIN', box, null)
  }

  const nose = landmarks[NOSE_INDEX]
  const idx = LANDMARK_INDEX[side]
  const shoulder = landmarks[idx.shoulder]
  const hip = landmarks[idx.hip]
  const knee = landmarks[idx.knee]
  const ankle = landmarks[idx.ankle]

  // 头顶边界：鼻点上移安全余量估计，鼻点在画内不代表头顶完整。
  const headTopY = nose.y - config.headMargin
  const bodyBottomY = ankle.y
  const humanBox: FramingBox = {
    x: Math.min(shoulder.x, hip.x, knee.x, ankle.x, nose.x),
    y: headTopY,
    width: 0,
    height: bodyBottomY - headTopY
  }
  const maxX = Math.max(shoulder.x, hip.x, knee.x, ankle.x, nose.x)
  humanBox.width = maxX - humanBox.x

  const centerX = humanBox.x + humanBox.width / 2

  if (headTopY < 0) return state('HEAD_OUT', box, humanBox)
  if (bodyBottomY > 1) return state('ANKLE_OUT', box, humanBox)
  if (humanBox.height > config.closeHeightRatio) return state('TOO_CLOSE', box, humanBox)
  if (centerX < 0.5 - config.centerOffsetRatio) return state('SHIFT_LEFT', box, humanBox)
  if (centerX > 0.5 + config.centerOffsetRatio) return state('SHIFT_RIGHT', box, humanBox)

  return state('READY', box, humanBox)
}
