// 分析管线内部类型。
import type { AngleSet, Side } from '@shared/types'

/** 每帧传入阶段识别与规则引擎的特征集合。 */
export interface FrameFeatures {
  timestamp: number
  side: Side
  angles: AngleSet
  /** 本帧数据是否可用（关键点可信且未过期）。 */
  valid: boolean
  /** 归一化图像坐标（0–1），用于位移特征。 */
  shoulderNorm: { x: number; y: number }
  hipNorm: { x: number; y: number }
}

export type { Side }
