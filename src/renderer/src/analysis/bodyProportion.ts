// 身体比例估计（v2/v3，T12）：从**可信、接近侧面且站立**的帧估计相对比例。
// 约束：在**原始像素坐标**计算各段长度（避免宽高比失真）；沿同一可信侧取肩—髋/髋—膝/膝—踝/肩—肘—腕；
// 以稳健中位数聚合；缺失项保留 null，不填"标准体型"；分母近零/关键点不足 → 对应比例 null 且质量降级。
import type { CredibleStandingFrame, Point2D, ProportionConfig, ProportionEstimate } from '@shared/types'
import { PROPORTION_FEATURE_VERSION } from '@shared/config'
import { LANDMARK_INDEX } from './geometry'

function dist(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function isFinitePoint(p: Point2D | undefined): p is Point2D {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y)
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** 相对中位数绝对偏差（MAD/median）；分母≤0 视为无有效离散度信息。 */
function relativeMad(values: number[], med: number): number {
  if (values.length === 0 || med <= 0) return 0
  const devs = values.map((v) => Math.abs(v - med))
  const mad = median(devs) ?? 0
  return mad / med
}

/**
 * 从可信站立帧估计相对身体比例。
 * 返回中位数比例、有效帧数、离散度与质量等级；缺失项为 null，不猜测。
 */
export function estimate(
  standingFrames: CredibleStandingFrame[],
  config: ProportionConfig
): ProportionEstimate {
  const thighToShin: number[] = []
  const trunkToLeg: number[] = []
  const armToTrunk: number[] = []
  let validFrames = 0

  for (const frame of standingFrames) {
    const idx = LANDMARK_INDEX[frame.side]
    const at = (i: number): Point2D | undefined => frame.keypoints[i]
    // 分段长度：低于最小长度视为不可信（近零分母会放大误差），返回 null 不参与。
    const seg = (a: number, b: number): number | null => {
      const pa = at(a)
      const pb = at(b)
      if (!isFinitePoint(pa) || !isFinitePoint(pb)) return null
      const d = dist(pa, pb)
      return d >= config.minSegmentConfidence ? d : null
    }

    const thigh = seg(idx.hip, idx.knee)
    const shin = seg(idx.knee, idx.ankle)
    const trunk = seg(idx.shoulder, idx.hip)
    const upperArm = seg(idx.shoulder, idx.elbow)
    const forearm = seg(idx.elbow, idx.wrist)

    let contributed = false
    if (thigh !== null && shin !== null && shin > 0) {
      thighToShin.push(thigh / shin)
      contributed = true
    }
    if (trunk !== null && thigh !== null && shin !== null && thigh + shin > 0) {
      trunkToLeg.push(trunk / (thigh + shin))
      contributed = true
    }
    if (upperArm !== null && forearm !== null && trunk !== null && trunk > 0) {
      armToTrunk.push((upperArm + forearm) / trunk)
      contributed = true
    }
    if (contributed) validFrames += 1
  }

  const thighMed = median(thighToShin)
  const trunkMed = median(trunkToLeg)
  const armMed = median(armToTrunk)

  const dispersions = [
    thighMed !== null ? relativeMad(thighToShin, thighMed) : null,
    trunkMed !== null ? relativeMad(trunkToLeg, trunkMed) : null,
    armMed !== null ? relativeMad(armToTrunk, armMed) : null
  ].filter((d): d is number => d !== null)
  const dispersion = dispersions.length > 0 ? Math.max(...dispersions) : 0

  const hasAnyRatio = thighMed !== null || trunkMed !== null || armMed !== null
  let quality: ProportionEstimate['quality']
  if (!hasAnyRatio) {
    quality = 'MISSING'
  } else if (validFrames >= config.minValidFrames && dispersion <= config.maxDispersion) {
    quality = 'OK'
  } else {
    quality = 'LOW'
  }

  return {
    featureVersion: PROPORTION_FEATURE_VERSION,
    ratios: { thighToShin: thighMed, trunkToLeg: trunkMed, armToTrunk: armMed },
    validFrames,
    dispersion,
    quality
  }
}
