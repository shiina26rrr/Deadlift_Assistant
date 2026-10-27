// 动作阶段状态机：可解释规则驱动（角度变化、位移方向、稳定时间），
// 不训练动作分类大模型。状态：IDLE / READY / PULLING / STANDING / LOWERING / DATA_INSUFFICIENT。
import type { Phase, PhaseConfig, PhaseState, PhaseTransition } from '@shared/types'
import type { FrameFeatures } from './types'

const HISTORY_LIMIT = 200

export function createInitialPhaseState(): PhaseState {
  return {
    current: 'IDLE',
    previous: 'IDLE',
    since: 0,
    stableDuration: 0,
    transitionHistory: []
  }
}

interface StandingReference {
  shoulderY: number
  hipY: number
  trunkLean: number
}

export class PhaseRecognizer {
  private state: PhaseState = createInitialPhaseState()
  private reference: StandingReference | null = null
  private uprightSince: number | null = null
  private standSince: number | null = null
  private leanSince: number | null = null
  private insufficientSince: number | null = null
  /** 起拉过程中的躯干前倾峰值（最低点）与起拉后回升后的最低前倾值。 */
  private pullPeakLean: number | null = null
  private pullRiseFloor: number | null = null
  private pullRising = false

  get current(): PhaseState {
    return this.state
  }

  reset(): void {
    this.state = createInitialPhaseState()
    this.reference = null
    this.uprightSince = null
    this.standSince = null
    this.leanSince = null
    this.insufficientSince = null
    this.pullPeakLean = null
    this.pullRiseFloor = null
    this.pullRising = false
  }

  /**
   * 时间线不连续（暂停后恢复/跳转）：清除推进中的计时与未完成状态，
   * 但保留已注入的站立参考，避免"界面已校准、阶段参考却丢失"。
   */
  resumeFromDiscontinuity(timestamp: number): void {
    this.uprightSince = null
    this.standSince = null
    this.leanSince = null
    this.insufficientSince = null
    this.pullPeakLean = null
    this.pullRiseFloor = null
    this.pullRising = false
    if (!this.reference) {
      this.state = createInitialPhaseState()
      return
    }
    this.state = {
      current: 'READY',
      previous: this.state.current,
      since: timestamp,
      stableDuration: 0,
      transitionHistory: this.state.transitionHistory
    }
  }

  /** 注入外部校准参考：阶段机直接进入准备，避免重复等待站立稳定。 */
  applyReference(
    ref: { shoulderY: number; hipY: number; trunkLean: number },
    timestamp: number
  ): void {
    this.reference = ref
    this.uprightSince = null
    this.standSince = null
    this.leanSince = null
    this.pullPeakLean = null
    this.pullRiseFloor = null
    this.pullRising = false
    if (this.state.current !== 'READY') {
      this.setState('READY', timestamp, '校准参考注入')
    }
  }

  private setState(next: Phase, timestamp: number, trigger: string): void {
    if (next === this.state.current) {
      this.state.stableDuration = timestamp - this.state.since
      return
    }
    if (next === 'PULLING') {
      this.pullPeakLean = null
      this.pullRiseFloor = null
      this.pullRising = false
    }
    const transition: PhaseTransition = {
      from: this.state.current,
      to: next,
      timestamp,
      trigger
    }
    this.state = {
      current: next,
      previous: this.state.current,
      since: timestamp,
      stableDuration: 0,
      transitionHistory: [...this.state.transitionHistory, transition].slice(-HISTORY_LIMIT)
    }
  }

  transition(features: FrameFeatures, config: PhaseConfig): PhaseState {
    const ts = features.timestamp

    // 数据不足：暂停阶段推进，不伪装冻结旧值。
    if (!features.valid) {
      if (this.state.current !== 'DATA_INSUFFICIENT') {
        this.insufficientSince = ts
        this.setState('DATA_INSUFFICIENT', ts, '关键点缺失/置信不足/数据过期')
      }
      return this.state
    }

    // 从数据不足恢复。
    if (this.state.current === 'DATA_INSUFFICIENT') {
      const gap = ts - (this.insufficientSince ?? ts)
      this.uprightSince = null
      this.standSince = null
      if (gap >= config.longInterruptMs) {
        // 长时间中断：重建状态，回到 IDLE 重新等待站立稳定。
        this.reference = null
        this.setState('IDLE', ts, '长时间中断后重建状态')
      } else if (!this.reference) {
        // 无站立参考时 READY 无法判定起拉（缺少躯干/位移基线），回到 IDLE 重新建立。
        this.setState('IDLE', ts, '无站立参考，重新等待')
      } else {
        // 短中断：回到准备，不补造动作。
        this.setState('READY', ts, '短暂中断恢复')
      }
      return this.state
    }

    const trunk = features.angles.trunkLeanAngle
    const knee = features.angles.kneeInnerAngle
    const trunkVal = trunk.validity === 'VALID' ? trunk.value : null
    const kneeVal = knee.validity === 'VALID' ? knee.value : null
    const hipDrop = this.reference ? features.hipNorm.y - this.reference.hipY : 0

    switch (this.state.current) {
      case 'IDLE': {
        // 站直只看躯干回正；膝关节不设统一合格角度（仅用于识别下放）。
        const upright = trunkVal !== null && trunkVal <= config.trunkUprightDeg
        if (upright) {
          this.leanSince = null
          if (this.uprightSince === null) this.uprightSince = ts
          if (ts - this.uprightSince >= config.readyStableMs) {
            this.reference = {
              shoulderY: features.shoulderNorm.y,
              hipY: features.hipNorm.y,
              trunkLean: trunkVal ?? 0
            }
            this.uprightSince = null
            this.setState('READY', ts, '站立稳定')
          }
        } else {
          this.uprightSince = null
          // 冷启动：分析在最低点开始（录像回放/直接握杠），无法先等到站立。
          // 持续俯身即视为起拉开始；随后稳定站直仍按完整动作收尾。
          const leaned = trunkVal !== null && kneeVal !== null && trunkVal >= config.trunkLeaningDeg
          if (leaned) {
            if (this.leanSince === null) this.leanSince = ts
            if (ts - this.leanSince >= config.readyStableMs) {
              this.leanSince = null
              this.setState('PULLING', ts, '俯身起拉（冷启动）')
            }
          } else {
            this.leanSince = null
          }
        }
        break
      }

      case 'READY': {
        const trunkIncrease = trunkVal !== null && this.reference ? trunkVal - this.reference.trunkLean : 0
        if (trunkVal !== null && (trunkIncrease >= config.leanThreshold || hipDrop >= config.displacementThreshold)) {
          this.setState('PULLING', ts, '起拉开始')
        }
        break
      }

      case 'PULLING': {
        const standing = trunkVal !== null && trunkVal <= config.trunkUprightDeg
        if (standing) {
          if (this.standSince === null) this.standSince = ts
          if (ts - this.standSince >= config.standStableMs) {
            this.standSince = null
            this.setState('STANDING', ts, '稳定站直')
          }
        } else {
          this.standSince = null
          // 未达稳定站直即下放：须先确认已从最低点开始上升，再出现明显反向，
          // 避免把"站立→俯身握杠"的正常下蹲误判为下放（原逻辑会中断每一次起拉）。
          if (trunkVal !== null) {
            if (this.pullPeakLean === null || trunkVal >= this.pullPeakLean) {
              this.pullPeakLean = trunkVal
              this.pullRiseFloor = trunkVal
              this.pullRising = false
            } else {
              if (!this.pullRising && this.pullPeakLean - trunkVal >= config.leanThreshold) {
                this.pullRising = true
                this.pullRiseFloor = trunkVal
              } else if (this.pullRising) {
                this.pullRiseFloor = Math.min(this.pullRiseFloor ?? trunkVal, trunkVal)
              }
              if (
                this.pullRising &&
                this.pullRiseFloor !== null &&
                trunkVal >= this.pullRiseFloor + config.leanThreshold
              ) {
                this.setState('LOWERING', ts, '未达站直即下放')
              }
            }
          }
        }
        break
      }

      case 'STANDING': {
        if (trunkVal !== null && trunkVal >= config.trunkLeaningDeg) {
          this.setState('LOWERING', ts, '开始下放')
        } else if (kneeVal !== null && kneeVal < config.kneeExtendedDeg - 15) {
          this.setState('LOWERING', ts, '膝屈曲下放')
        }
        break
      }

      case 'LOWERING': {
        // 站直只看躯干回正；膝关节不设统一合格角度（仅用于识别下放）。
        const upright = trunkVal !== null && trunkVal <= config.trunkUprightDeg
        if (upright) {
          if (this.uprightSince === null) this.uprightSince = ts
          if (ts - this.uprightSince >= config.readyStableMs) {
            this.uprightSince = null
            this.reference = {
              shoulderY: features.shoulderNorm.y,
              hipY: features.hipNorm.y,
              trunkLean: trunkVal ?? 0
            }
            this.setState('READY', ts, '回到准备')
          }
        } else {
          this.uprightSince = null
        }
        break
      }
    }

    this.state.stableDuration = ts - this.state.since
    return this.state
  }
}
