import { describe, expect, it } from 'vitest'
import { computeWindowLayout } from '../src/main/windowLayout'

const preferred = { width: 1600, height: 900 }
const minimum = { width: 1024, height: 680 }

describe('computeWindowLayout', () => {
  it('工作区足够时使用偏好尺寸并居中', () => {
    const layout = computeWindowLayout({ x: 0, y: 0, width: 1920, height: 1040 }, preferred, minimum)
    expect(layout).toEqual({ width: 1600, height: 900, minWidth: 1024, minHeight: 680, x: 160, y: 70 })
  })

  it('1366×728 工作区下窗口不超出且保持最小高度', () => {
    const layout = computeWindowLayout({ x: 0, y: 0, width: 1366, height: 728 }, preferred, minimum)
    expect(layout.width).toBe(1242)
    expect(layout.height).toBe(680)
    expect(layout.minWidth).toBe(1024)
    expect(layout.minHeight).toBe(680)
    expect(layout.x).toBe(62)
    expect(layout.y).toBe(24)
    expect(layout.width).toBeLessThanOrEqual(1366)
    expect(layout.height).toBeLessThanOrEqual(728)
  })

  it('150% 缩放下的小工作区窗口完整可见', () => {
    const layout = computeWindowLayout({ x: 0, y: 0, width: 911, height: 512 }, preferred, minimum)
    expect(layout.width).toBe(895)
    expect(layout.height).toBe(496)
    expect(layout.minWidth).toBe(895)
    expect(layout.minHeight).toBe(496)
    expect(layout.width).toBeLessThanOrEqual(911)
    expect(layout.height).toBeLessThanOrEqual(512)
  })

  it('小于最小承诺的工作区按可用空间收缩', () => {
    const layout = computeWindowLayout({ x: 0, y: 0, width: 800, height: 600 }, preferred, minimum)
    expect(layout.width).toBe(784)
    expect(layout.height).toBe(584)
    expect(layout.width).toBeLessThanOrEqual(800)
    expect(layout.height).toBeLessThanOrEqual(600)
  })

  it('超宽矮工作区保持宽度偏好并压缩高度', () => {
    const layout = computeWindowLayout({ x: 0, y: 0, width: 2560, height: 664 }, preferred, minimum)
    expect(layout.width).toBe(1600)
    expect(layout.height).toBe(648)
    expect(layout.height).toBeLessThanOrEqual(664)
  })

  it('多显示器偏移工作区按工作区原点居中', () => {
    const layout = computeWindowLayout({ x: 1920, y: -200, width: 1366, height: 728 }, preferred, minimum)
    expect(layout.x).toBe(1920 + 62)
    expect(layout.y).toBe(-200 + 24)
  })
})
