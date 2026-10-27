import { describe, expect, it } from 'vitest'
import { SideSelector } from '@renderer/analysis/sideSelector'
import type { SideConfig } from '@shared/types'

const baseConfig: SideConfig = { switchHysteresis: 0.15, minConfidence: 0.4, manualSide: null }

describe('SideSelector 可见侧选择', () => {
  it('首次选择置信度更高的一侧', () => {
    const selectorRight = new SideSelector()
    expect(selectorRight.select(0.5, 0.6, baseConfig).side).toBe('right')
    const selectorLeft = new SideSelector()
    expect(selectorLeft.select(0.7, 0.6, baseConfig).side).toBe('left')
  })

  it('滞回避免频繁切换', () => {
    const selector = new SideSelector()
    selector.select(0.5, 0.6, baseConfig) // 选右
    // 左侧仅略高（差 0.05 < 0.15），保持右侧
    expect(selector.select(0.65, 0.6, baseConfig)).toEqual({ side: 'right', switched: false })
    // 左侧明显更高（差 0.2 > 0.15），切换
    expect(selector.select(0.8, 0.6, baseConfig)).toEqual({ side: 'left', switched: true })
  })

  it('当前侧置信度过低时切换到可用侧', () => {
    const selector = new SideSelector()
    selector.select(0.5, 0.6, baseConfig) // 选右
    const result = selector.select(0.5, 0.2, baseConfig)
    expect(result.side).toBe('left')
    expect(result.switched).toBe(true)
  })

  it('手动指定侧别时优先使用', () => {
    const selector = new SideSelector()
    const result = selector.select(0.9, 0.9, { ...baseConfig, manualSide: 'left' })
    expect(result.side).toBe('left')
  })

  it('两侧都不可用时保持当前侧', () => {
    const selector = new SideSelector()
    selector.select(0.9, 0.5, baseConfig) // 选左
    const result = selector.select(0.2, 0.3, baseConfig)
    expect(result.side).toBe('left')
    expect(result.switched).toBe(false)
  })
})
