// 站立校准：从 2–3 秒站立帧序列采集个人站立参考值。
// 仅在关键点清晰且姿态稳定时成功；不把弯腰起始帧当作站立参考。
import type {
  AngleSet,
  BodyProportionReference,
  CalibrationConfig,
  CalibrationFrame,
  CalibrationReference,
  Side
} from '@shared/types'
import { computeAnglesFromPixels } from './geometry'

export interface CalibrationResult {
  success: boolean
  reference?: CalibrationReference
  reason?: string
  /** 校准窗口内估计并冻结的身体比例参考（仅成功时提供；单目投影近似）。 */
  proportion?: BodyProportionReference
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}

function stdDev(values: number[]): number {
  if (values.length < 2) return Number.POSITIVE_INFINITY
  const m = mean(values)
  const variance = mean(values.map((v) => (v - m) ** 2))
  return Math.sqrt(variance)
}

export function calibrate(
  frames: CalibrationFrame[],
  side: Side,
  config: CalibrationConfig
): CalibrationResult {
  if (frames.length === 0) {
    return { success: false, reason: '未采集到站立帧，请保持站立后重试' }
  }

  const span = frames[frames.length - 1].timestamp - frames[0].timestamp
  if (span < config.durationMs) {
    return { success: false, reason: `采集时长不足（${(span / 1000).toFixed(1)}s），需约 ${(config.durationMs / 1000).toFixed(1)}s` }
  }

  const angleSets: AngleSet[] = []
  let clearFrames = 0
  for (const frame of frames) {
    const angles = computeAnglesFromPixels(frame.keypoints, side, config.minConfidence)
    const allValid =
      angles.armGroundAngle.validity === 'VALID' &&
      angles.elbowInnerAngle.validity === 'VALID' &&
      angles.kneeInnerAngle.validity === 'VALID' &&
      angles.trunkLeanAngle.validity === 'VALID'
    if (allValid) {
      clearFrames += 1
      angleSets.push(angles)
    }
  }

  // 要求足够比例的关键点清晰帧。
  if (clearFrames < frames.length * 0.6 || angleSets.length < 2) {
    return { success: false, reason: '关键点不清晰，请确保相关肢体完整入镜后重试' }
  }

  const trunkValues = angleSets.map((a) => a.trunkLeanAngle.value)
  const kneeValues = angleSets.map((a) => a.kneeInnerAngle.value)

  // 站立参考：躯干应接近竖直、膝盖接近伸直。
  if (mean(trunkValues) > 20) {
    return { success: false, reason: '当前姿态并非站立（躯干前倾较大），请在站直时校准' }
  }
  if (mean(kneeValues) < 150) {
    return { success: false, reason: '当前膝盖明显屈曲，请在站直时校准' }
  }
  if (stdDev(trunkValues) > config.stabilityThreshold || stdDev(kneeValues) > config.stabilityThreshold) {
    return { success: false, reason: '姿态不稳定，请在站直后保持 2–3 秒再校准' }
  }

  const reference: CalibrationReference = {
    standingAngles: {
      armGroundAngle: { value: mean(angleSets.map((a) => a.armGroundAngle.value)), validity: 'VALID' },
      elbowInnerAngle: { value: mean(angleSets.map((a) => a.elbowInnerAngle.value)), validity: 'VALID' },
      kneeInnerAngle: { value: mean(kneeValues), validity: 'VALID' },
      trunkLeanAngle: { value: mean(trunkValues), validity: 'VALID' }
    },
    side,
    capturedAt: frames[frames.length - 1].timestamp
  }
  return { success: true, reference }
}
