import { describe, expect, it } from 'vitest'
import type { NormalizedLandmark } from '@shared/types'
import { DEFAULT_CONFIG } from '@shared/config'
import { evaluate, framingBox, FRAMING_MESSAGE } from '@renderer/analysis/framing'
import { makeLandmarks } from './helpers'

const config = DEFAULT_CONFIG.framing

/** 人体完整站立（左侧）：头顶 0.07–脚踝 0.9，水平居中。 */
function standing(overrides: Record<number, Partial<NormalizedLandmark>> = {}): NormalizedLandmark[] {
  return makeLandmarks({
    0: { x: 0.5, y: 0.15 },
    11: { x: 0.5, y: 0.3 },
    23: { x: 0.5, y: 0.6 },
    25: { x: 0.5, y: 0.75 },
    27: { x: 0.5, y: 0.9 },
    ...overrides
  })
}

function allInvisible(): NormalizedLandmark[] {
  return makeLandmarks().map((p) => ({ ...p, visibility: 0 }))
}

describe('framing.evaluate', () => {
  it('完整入框时判定为 READY 并可进入校准', () => {
    const result = evaluate(standing(), config)
    expect(result.status).toBe('READY')
    expect(result.ready).toBe(true)
    expect(result.message).toBe(FRAMING_MESSAGE.READY)
    expect(result.humanBox).not.toBeNull()
  })

  it('空关键点判定为未检测到人', () => {
    expect(evaluate([], config).status).toBe('UNDETECTED')
  })

  it('两侧关键点均不可见判定为未检测到人', () => {
    expect(evaluate(allInvisible(), config).status).toBe('UNDETECTED')
  })

  it('鼻点在画内但头顶越出上边界判定为头部出画', () => {
    const result = evaluate(standing({ 0: { x: 0.5, y: 0.05 } }), config)
    expect(result.status).toBe('HEAD_OUT')
    expect(result.ready).toBe(false)
  })

  it('脚踝越出下边界判定为脚踝出画', () => {
    const result = evaluate(standing({ 27: { x: 0.5, y: 1.05 } }), config)
    expect(result.status).toBe('ANKLE_OUT')
  })

  it('人体高度占满画幅判定为过近', () => {
    const result = evaluate(
      standing({ 0: { x: 0.5, y: 0.09 }, 27: { x: 0.5, y: 0.999 } }),
      config
    )
    expect(result.status).toBe('TOO_CLOSE')
  })

  it('人体中心偏左/偏右给出对应提示', () => {
    const left = standing({
      0: { x: 0.1, y: 0.15 },
      11: { x: 0.1, y: 0.3 },
      23: { x: 0.1, y: 0.6 },
      25: { x: 0.1, y: 0.75 },
      27: { x: 0.1, y: 0.9 }
    })
    expect(evaluate(left, config).status).toBe('SHIFT_LEFT')

    const right = standing({
      0: { x: 0.9, y: 0.15 },
      11: { x: 0.9, y: 0.3 },
      23: { x: 0.9, y: 0.6 },
      25: { x: 0.9, y: 0.75 },
      27: { x: 0.9, y: 0.9 }
    })
    expect(evaluate(right, config).status).toBe('SHIFT_RIGHT')
  })

  it('关键点置信不足判定为无法确认，不猜测包围框', () => {
    const result = evaluate(standing({ 25: { x: 0.5, y: 0.75, visibility: 0.1 }, 26: { x: 0.5, y: 0.75, visibility: 0.1 } }), config)
    expect(result.status).toBe('UNCERTAIN')
    expect(result.humanBox).toBeNull()
    expect(result.ready).toBe(false)
  })

  it('引导框为居中的竖向框且上下留有边距', () => {
    const box = framingBox(config)
    expect(box.x + box.width / 2).toBeCloseTo(0.5, 6)
    expect(box.y).toBeCloseTo(config.boxMarginTop, 6)
    expect(box.y + box.height).toBeCloseTo(1 - config.boxMarginBottom, 6)
    expect(box.height).toBeGreaterThan(0)
  })

  it('每个入框状态都有非空中文提示', () => {
    for (const message of Object.values(FRAMING_MESSAGE)) {
      expect(message.length).toBeGreaterThan(0)
    }
  })
})
