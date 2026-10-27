// 关键点帧滑动平均滤波：低置信点不纳入窗口；超过过期时限清空窗口，
// 不把长期冻结的旧值伪装成实时数据。
import type { FilterConfig, Point2D } from '@shared/types'

interface Sample {
  x: number
  y: number
  visibility: number
  timestamp: number
}

export class SlidingFilter {
  private readonly count: number
  private windows: Sample[][] = []
  private lastTimestamp = 0

  constructor(count = 33) {
    this.count = count
    this.reset()
  }

  reset(): void {
    this.windows = Array.from({ length: this.count }, () => [])
    this.lastTimestamp = 0
  }

  /** 滤波器内部是否已无任何有效样本（用于判定数据不足）。 */
  isEmpty(): boolean {
    return this.windows.every((w) => w.length === 0)
  }

  update(points: Point2D[], timestamp: number, config: FilterConfig): Point2D[] {
    if (this.lastTimestamp !== 0 && timestamp - this.lastTimestamp > config.expiryMs) {
      this.reset()
    }
    this.lastTimestamp = timestamp

    const output: Point2D[] = []
    for (let i = 0; i < this.count; i += 1) {
      const point = points[i]
      const window = this.windows[i]

      // 丢弃过期样本。
      while (window.length > 0 && timestamp - window[0].timestamp > config.expiryMs) {
        window.shift()
      }

      // 仅纳入置信度达标的点。
      if (
        point &&
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        point.visibility >= config.confidenceThreshold
      ) {
        window.push({ x: point.x, y: point.y, visibility: point.visibility, timestamp })
        while (window.length > config.windowSize) window.shift()
      }

      if (window.length === 0) {
        // 无可用样本：输出不可用（visibility=0，坐标 NaN），由几何层标记为不可用。
        output.push({ x: Number.NaN, y: Number.NaN, visibility: 0 })
      } else {
        let sx = 0
        let sy = 0
        let sv = 0
        for (const sample of window) {
          sx += sample.x
          sy += sample.y
          sv += sample.visibility
        }
        output.push({
          x: sx / window.length,
          y: sy / window.length,
          visibility: sv / window.length
        })
      }
    }
    return output
  }
}
