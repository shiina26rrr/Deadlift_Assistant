import { describe, expect, it } from 'vitest'
import { Counter } from '@renderer/analysis/counter'
import type { Phase, PhaseState } from '@shared/types'

function ps(current: Phase, since = 0): PhaseState {
  return { current, previous: current, since, stableDuration: 0, transitionHistory: [] }
}

describe('Counter 计次规则', () => {
  it('准备→起拉→稳定站直记一次完成动作', () => {
    const counter = new Counter()
    counter.onPhaseChange(ps('READY'), ps('PULLING'), 1000)
    counter.onPhaseChange(ps('PULLING'), ps('STANDING'), 2000)
    expect(counter.value.completedCount).toBe(1)
    expect(counter.value.actionTimestamps).toEqual([2000])
  })

  it('站立开场（未经过起拉）不计次', () => {
    const counter = new Counter()
    counter.onPhaseChange(ps('IDLE'), ps('READY'), 500)
    expect(counter.value.completedCount).toBe(0)
  })

  it('未达站直即下放记为未完成片段', () => {
    const counter = new Counter()
    counter.onPhaseChange(ps('READY'), ps('PULLING'), 1000)
    counter.onPhaseChange(ps('PULLING'), ps('LOWERING'), 1500)
    expect(counter.value.completedCount).toBe(0)
    expect(counter.value.incompleteSegments).toEqual([{ start: 1000, end: 1500 }])
  })

  it('必须回到准备后才允许下一次计数', () => {
    const counter = new Counter()
    counter.onPhaseChange(ps('READY'), ps('PULLING'), 1000)
    counter.onPhaseChange(ps('PULLING'), ps('STANDING'), 2000)
    // 同一次站直保持不重复计数
    counter.onPhaseChange(ps('STANDING'), ps('STANDING'), 2200)
    expect(counter.value.completedCount).toBe(1)
    // 下放回到准备后，再次动作才计数
    counter.onPhaseChange(ps('STANDING'), ps('LOWERING'), 2500)
    counter.onPhaseChange(ps('LOWERING'), ps('READY'), 3000)
    counter.onPhaseChange(ps('READY'), ps('PULLING'), 3500)
    counter.onPhaseChange(ps('PULLING'), ps('STANDING'), 4000)
    expect(counter.value.completedCount).toBe(2)
  })

  it('遮挡导致的中断被记录，且不补造动作', () => {
    const counter = new Counter()
    counter.onPhaseChange(ps('READY'), ps('PULLING'), 1000)
    counter.onPhaseChange(ps('PULLING'), ps('DATA_INSUFFICIENT'), 1200)
    counter.onPhaseChange(ps('DATA_INSUFFICIENT'), ps('READY'), 1400)
    expect(counter.value.completedCount).toBe(0)
    expect(counter.value.incompleteSegments).toEqual([{ start: 1000, end: 1200 }])
    expect(counter.value.interruptions).toEqual([{ start: 1200, end: 1400 }])
  })
})
