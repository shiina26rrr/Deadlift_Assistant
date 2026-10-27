import { describe, expect, it } from 'vitest'
import { SlidingFilter } from '@renderer/analysis/filter'
import type { FilterConfig, Point2D } from '@shared/types'
import { pixelPoints } from './helpers'

const config: FilterConfig = { windowSize: 3, confidenceThreshold: 0.5, expiryMs: 200 }

function withShoulder(x: number, y: number, visibility: number): Point2D[] {
  const points = pixelPoints()
  points[11] = { x, y, visibility }
  return points
}

describe('SlidingFilter 滑动平均', () => {
  it('对连续帧取平均', () => {
    const filter = new SlidingFilter(33)
    filter.update(withShoulder(0, 0, 0.9), 1000, config)
    const out = filter.update(withShoulder(10, 10, 0.9), 1100, config)
    expect(out[11].x).toBeCloseTo(5)
    expect(out[11].y).toBeCloseTo(5)
  })

  it('低置信点不纳入平均窗口', () => {
    const filter = new SlidingFilter(33)
    filter.update(withShoulder(0, 0, 0.9), 1000, config)
    const out = filter.update(withShoulder(100, 100, 0.1), 1050, config)
    // 窗口内仅有第一帧的有效样本
    expect(out[11].x).toBeCloseTo(0)
    expect(out[11].y).toBeCloseTo(0)
  })

  it('超过过期时限后窗口清空并返回不可用', () => {
    const filter = new SlidingFilter(33)
    filter.update(withShoulder(0, 0, 0.9), 1000, config)
    // 第二帧间隔 500ms > expiryMs 200，触发全局清空；
    // 且肩部置信度低于阈值，不纳入窗口 → 该关键点不可用。
    const out = filter.update(withShoulder(100, 100, 0.1), 1500, config)
    expect(Number.isNaN(out[11].x)).toBe(true)
    expect(out[11].visibility).toBe(0)
  })

  it('无有效样本时返回 NaN 与 visibility 0', () => {
    const filter = new SlidingFilter(33)
    const out = filter.update(withShoulder(10, 10, 0.1), 1000, config)
    expect(Number.isNaN(out[11].x)).toBe(true)
    expect(out[11].visibility).toBe(0)
  })
})
