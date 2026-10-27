// 计次器：必须经过 准备→起拉→稳定站直 才记一次完成动作；
// 站立开场不计次；同一次站直保持不重复计数；下放回到准备后才允许下一次；
// 未达稳定站直即下放记录为未完成片段；遮挡后重新出现不补造动作。
import type { CountRecord, PhaseState } from '@shared/types'

export function createEmptyCountRecord(): CountRecord {
  return {
    completedCount: 0,
    incompleteSegments: [],
    interruptions: [],
    actionTimestamps: []
  }
}

export class Counter {
  private record: CountRecord = createEmptyCountRecord()
  private pullStart: number | null = null
  private openInterruption: number | null = null

  get value(): CountRecord {
    return this.record
  }

  reset(): void {
    this.record = createEmptyCountRecord()
    this.pullStart = null
    this.openInterruption = null
  }

  /** 时间线断点（暂停/跳转）：丢弃未完成的起拉，不影响已完成次数。 */
  suspend(): void {
    this.pullStart = null
    this.openInterruption = null
  }

  onPhaseChange(previous: PhaseState, next: PhaseState, timestamp: number): void {
    const from = previous.current
    const to = next.current

    // 记录中断区间（数据不足起止）。
    if (to === 'DATA_INSUFFICIENT' && from !== 'DATA_INSUFFICIENT') {
      this.openInterruption = timestamp
      // 起拉过程中被遮挡：记为未完成片段，不补造完成次数。
      if (from === 'PULLING' && this.pullStart !== null) {
        this.record.incompleteSegments.push({ start: this.pullStart, end: timestamp })
        this.pullStart = null
      }
    } else if (from === 'DATA_INSUFFICIENT' && to !== 'DATA_INSUFFICIENT' && this.openInterruption !== null) {
      this.record.interruptions.push({ start: this.openInterruption, end: timestamp })
      this.openInterruption = null
    }

    if (to === 'PULLING' && from !== 'PULLING') {
      this.pullStart = timestamp
    }

    if (from === 'PULLING' && to === 'STANDING') {
      // 完成一次达到顶部的动作。
      this.record.completedCount += 1
      this.record.actionTimestamps.push(timestamp)
      this.pullStart = null
    }

    if (from === 'PULLING' && to === 'LOWERING') {
      // 未达稳定站直即下放：未完成片段。
      if (this.pullStart !== null) {
        this.record.incompleteSegments.push({ start: this.pullStart, end: timestamp })
        this.pullStart = null
      }
    }
  }
}
