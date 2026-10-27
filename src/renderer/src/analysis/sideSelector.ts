// 可见侧选择：自动选较可信一侧，使用切换滞回避免频繁切换。
// 一次动作期间保持同侧；发生切换时调用方应清理相关历史数据。
import type { Side, SideConfig } from '@shared/types'

export interface SideSelection {
  side: Side
  switched: boolean
}

export class SideSelector {
  private current: Side | null = null

  reset(): void {
    this.current = null
  }

  get side(): Side | null {
    return this.current
  }

  select(leftConfidence: number, rightConfidence: number, config: SideConfig): SideSelection {
    if (config.manualSide) {
      const switched = this.current !== null && this.current !== config.manualSide
      this.current = config.manualSide
      return { side: config.manualSide, switched }
    }

    const leftOk = leftConfidence >= config.minConfidence
    const rightOk = rightConfidence >= config.minConfidence

    if (!leftOk && !rightOk) {
      // 两侧都不可用：保持当前侧（若无则默认左侧），不切换。
      const side = this.current ?? 'left'
      return { side, switched: false }
    }

    if (this.current === null) {
      const side: Side = rightConfidence > leftConfidence ? 'right' : 'left'
      this.current = side
      return { side, switched: false }
    }

    const currentConf = this.current === 'left' ? leftConfidence : rightConfidence
    const other: Side = this.current === 'left' ? 'right' : 'left'
    const otherConf = other === 'left' ? leftConfidence : rightConfidence

    if (currentConf < config.minConfidence && otherConf >= config.minConfidence) {
      this.current = other
      return { side: other, switched: true }
    }
    if (otherConf > currentConf + config.switchHysteresis) {
      this.current = other
      return { side: other, switched: true }
    }
    return { side: this.current, switched: false }
  }
}
