import { describe, expect, it } from 'vitest'
import { PhaseRecognizer } from '@renderer/analysis/phaseRecognizer'
import type { PhaseConfig } from '@shared/types'
import { angleEntry, makeAngleSet, makeFeatures } from './helpers'

const config: PhaseConfig = {
  readyStableMs: 200,
  standStableMs: 100,
  leanThreshold: 12,
  longInterruptMs: 3000,
  kneeExtendedDeg: 160,
  trunkUprightDeg: 12,
  trunkLeaningDeg: 30,
  displacementThreshold: 0.06
}

const standing = (timestamp: number) =>
  makeFeatures({
    timestamp,
    angles: makeAngleSet({
      trunkLeanAngle: angleEntry(5),
      kneeInnerAngle: angleEntry(175)
    })
  })

const leaning = (timestamp: number) =>
  makeFeatures({
    timestamp,
    angles: makeAngleSet({
      trunkLeanAngle: angleEntry(35),
      kneeInnerAngle: angleEntry(120)
    })
  })

const leanAt = (timestamp: number, trunk: number) =>
  makeFeatures({
    timestamp,
    angles: makeAngleSet({
      trunkLeanAngle: angleEntry(trunk),
      kneeInnerAngle: angleEntry(120)
    })
  })

const invalid = (timestamp: number) => makeFeatures({ timestamp, valid: false })

describe('PhaseRecognizer 阶段状态机', () => {
  it('站立稳定后进入准备，起拉后稳定站直，下放回到准备', () => {
    const recognizer = new PhaseRecognizer()
    expect(recognizer.transition(standing(0), config).current).toBe('IDLE')
    expect(recognizer.transition(standing(200), config).current).toBe('READY')
    expect(recognizer.transition(leaning(400), config).current).toBe('PULLING')
    expect(recognizer.transition(standing(500), config).current).toBe('PULLING')
    expect(recognizer.transition(standing(600), config).current).toBe('STANDING')
    expect(recognizer.transition(leaning(700), config).current).toBe('LOWERING')
    expect(recognizer.transition(standing(800), config).current).toBe('LOWERING')
    expect(recognizer.transition(standing(1000), config).current).toBe('READY')
  })

  it('下蹲到最低点不算下放；上升后反向才进入下放', () => {
    const recognizer = new PhaseRecognizer()
    recognizer.transition(standing(0), config)
    recognizer.transition(standing(200), config) // READY
    expect(recognizer.transition(leaning(400), config).current).toBe('PULLING')
    // 站立→俯身握杠：继续前倾是正常下蹲，不得中断起拉。
    expect(recognizer.transition(leanAt(500, 60), config).current).toBe('PULLING')
    // 已从最低点回升后再次明显下放 → 未完成。
    expect(recognizer.transition(leanAt(600, 40), config).current).toBe('PULLING')
    expect(recognizer.transition(leanAt(700, 20), config).current).toBe('PULLING')
    expect(recognizer.transition(leanAt(800, 35), config).current).toBe('LOWERING')
  })

  it('从最低点开始也能识别起拉（冷启动）', () => {
    const recognizer = new PhaseRecognizer()
    expect(recognizer.transition(leaning(0), config).current).toBe('IDLE')
    expect(recognizer.transition(leaning(200), config).current).toBe('PULLING')
    expect(recognizer.transition(standing(300), config).current).toBe('PULLING')
    expect(recognizer.transition(standing(400), config).current).toBe('STANDING')
  })

  it('无站立参考的短中断回到 IDLE，而不是卡在 READY', () => {
    const recognizer = new PhaseRecognizer()
    expect(recognizer.transition(invalid(0), config).current).toBe('DATA_INSUFFICIENT')
    expect(recognizer.transition(standing(100), config).current).toBe('IDLE')
  })

  it('数据不足进入 DATA_INSUFFICIENT，短中断恢复到准备', () => {
    const recognizer = new PhaseRecognizer()
    recognizer.transition(standing(0), config)
    recognizer.transition(standing(200), config) // READY
    expect(recognizer.transition(invalid(300), config).current).toBe('DATA_INSUFFICIENT')
    expect(recognizer.transition(standing(400), config).current).toBe('READY')
  })

  it('长时间中断回到 IDLE 重建状态', () => {
    const recognizer = new PhaseRecognizer()
    recognizer.transition(standing(0), config)
    recognizer.transition(standing(200), config) // READY
    recognizer.transition(invalid(300), config)
    expect(recognizer.transition(standing(4000), config).current).toBe('IDLE')
  })

  it('站立开场不会自动进入起拉或产生计数路径', () => {
    const recognizer = new PhaseRecognizer()
    // 一直站立：状态停留在 READY
    recognizer.transition(standing(0), config)
    recognizer.transition(standing(200), config)
    expect(recognizer.transition(standing(500), config).current).toBe('READY')
  })
})
