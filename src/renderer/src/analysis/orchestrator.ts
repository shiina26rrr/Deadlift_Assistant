// 分析编排器：串联 像素还原 → 选侧 → 滤波 → 角度 → 有效性 → 阶段 → 计次 → 规则。
// 所有推理结果在此汇合成只读快照，供 UI 渲染；姿态提取在 Worker 中异步完成。
import type {
  AngleSet,
  AppConfig,
  CalibrationFrame,
  CountRecord,
  FrameSize,
  NormalizedLandmark,
  Phase,
  Point2D,
  SegmentedAction,
  SessionData,
  Side
} from '@shared/types'
import {
  allAnglesValid,
  computeAnglesFromPixels,
  LANDMARK_INDEX,
  restorePixels,
  sideConfidence
} from './geometry'
import { SlidingFilter } from './filter'
import { SideSelector } from './sideSelector'
import { PhaseRecognizer } from './phaseRecognizer'
import { Counter, createEmptyCountRecord } from './counter'
import { RuleEngine } from './ruleEngine'
import { aggregateAngleRanges } from './reportGenerator'
import { calibrate, type CalibrationResult } from './calibration'
import { estimate } from './bodyProportion'
import type { FrameFeatures } from './types'

/** 一次动作的分段累积器（PULLING→STANDING 之间），收尾后生成 SegmentedAction。 */
interface OpenAction {
  index: number
  side: Side
  startMs: number
  frames: AngleSet[]
  timestamps: number[]
  shoulderY: number[]
  hipY: number[]
  ankleY: number[]
}

const MAX_ANGLE_SAMPLES = 20000

/** 最低点平台容差：躯干前倾角在此范围内视为仍处于最低点，裁剪从其后的上升帧开始。 */
const ASCENT_PLATEAU_DEG = 1.0

/**
 * 上升段起点：动作窗口内躯干前倾最大（最低点）处，再越过角度平台。
 * 实时视频包含"站立→俯身到杠"的下蹲段，录像则可能直接从最低点开始；
 * 统一裁到最低点之后的上升段，训练端使用同一规则（analysis_protocol.py）。
 */
function ascentStartIndex(frames: AngleSet[]): number {
  let maxIndex = -1
  let maxValue = Number.NEGATIVE_INFINITY
  for (let i = 0; i < frames.length; i += 1) {
    const angle = frames[i].trunkLeanAngle
    if (angle.validity !== 'VALID' || !Number.isFinite(angle.value)) continue
    if (angle.value > maxValue) {
      maxValue = angle.value
      maxIndex = i
    }
  }
  if (maxIndex < 0) return 0
  let index = maxIndex
  while (index + 1 < frames.length) {
    const next = frames[index + 1].trunkLeanAngle
    if (next.validity !== 'VALID' || !Number.isFinite(next.value)) break
    if (next.value < maxValue - ASCENT_PLATEAU_DEG) break
    index += 1
  }
  return index < frames.length - 1 ? index : 0
}

const EMPTY_ANGLES: AngleSet = {
  armGroundAngle: { value: 0, validity: 'UNAVAILABLE' },
  elbowInnerAngle: { value: 0, validity: 'UNAVAILABLE' },
  kneeInnerAngle: { value: 0, validity: 'UNAVAILABLE' },
  trunkLeanAngle: { value: 0, validity: 'UNAVAILABLE' }
}

export interface AnalysisSnapshot {
  phase: Phase
  phaseSince: number
  count: number
  incompleteCount: number
  angles: AngleSet
  side: Side | null
  dataValid: boolean
  coverageRatio: number
  filteredPixels: Point2D[]
  landmarks: NormalizedLandmark[]
  running: boolean
}

export class AnalysisOrchestrator {
  private config: AppConfig
  private onUpdate: (snapshot: AnalysisSnapshot) => void

  private filter = new SlidingFilter()
  private sideSelector = new SideSelector()
  private phase = new PhaseRecognizer()
  private counter = new Counter()
  private rules = new RuleEngine()

  private angleSamples: AngleSet[] = []
  private actionIntervals: number[] = []
  private validFrames = 0
  private totalFrames = 0
  private lastTimestamp = 0
  private sessionStart: number | null = null
  private running = false
  private metricValidFrames = { armGround: 0, elbowInner: 0, kneeInner: 0, trunkLean: 0 }

  private calibrating = false
  private calibrationFrames: CalibrationFrame[] = []

  /** 本组已完成的动作分段（完成动作；不参与计次，仅供本地模型推理）。 */
  private actionSegments: SegmentedAction[] = []
  private openAction: OpenAction | null = null

  constructor(config: AppConfig, onUpdate: (snapshot: AnalysisSnapshot) => void) {
    this.config = config
    this.onUpdate = onUpdate
  }

  get isRunning(): boolean {
    return this.running
  }

  /** 供报告生成读取的"整次动作"分段（训练/运行时特征提取单位）。 */
  get segmentedActions(): SegmentedAction[] {
    return this.actionSegments
  }

  /** 切换配置（例如设置面板修改参数）后调用，不重置会话数据。 */
  updateConfig(config: AppConfig): void {
    this.config = config
  }

  /** 完整重置：切换输入源或开始新的分析会话时调用。 */
  reset(): void {
    this.filter.reset()
    this.sideSelector.reset()
    this.phase.reset()
    this.counter.reset()
    this.rules.reset()
    this.angleSamples = []
    this.actionIntervals = []
    this.validFrames = 0
    this.totalFrames = 0
    this.lastTimestamp = 0
    this.sessionStart = null
    this.running = false
    this.calibrating = false
    this.calibrationFrames = []
    this.metricValidFrames = { armGround: 0, elbowInner: 0, kneeInner: 0, trunkLean: 0 }
    this.actionSegments = []
    this.openAction = null
  }

  /**
   * 暂停/跳转后的连续性重置：清滤波与推进中的动作分段，保留已完成次数、
   * 角度样本与已注入的站立参考。切换输入源请使用 reset()。
   */
  suspendContinuity(timestamp: number): void {
    this.filter.reset()
    this.phase.resumeFromDiscontinuity(timestamp)
    this.counter.suspend()
    this.openAction = null
    this.lastTimestamp = timestamp
  }

  begin(timestamp: number): void {
    this.counter.reset()
    this.rules.reset()
    this.angleSamples = []
    this.actionIntervals = []
    this.validFrames = 0
    this.totalFrames = 0
    this.sessionStart = timestamp
    this.running = true
    this.metricValidFrames = { armGround: 0, elbowInner: 0, kneeInner: 0, trunkLean: 0 }
    this.actionSegments = []
    this.openAction = null
  }

  beginCalibration(): void {
    this.calibrating = true
    this.calibrationFrames = []
  }

  /** 取消进行中的校准采集（暂停/跳转/换源）：不产生参考，也不带入暂停帧。 */
  cancelCalibration(): void {
    this.calibrating = false
    this.calibrationFrames = []
  }

  endCalibration(): CalibrationResult {
    this.calibrating = false
    const side = this.sideSelector.side ?? 'left'
    const frames = this.calibrationFrames
    const result = calibrate(frames, side, this.config.calibration)
    if (result.success && result.reference && frames.length > 0) {
      // 校准参考真正进入阶段判断：注入参考并直接进入准备，与倒计时衔接。
      const last = frames[frames.length - 1]
      const idx = LANDMARK_INDEX[side]
      const ref = result.reference.standingAngles
      this.phase.applyReference(
        {
          shoulderY: last.keypoints[idx.shoulder]?.y ?? 0,
          hipY: last.keypoints[idx.hip]?.y ?? 0,
          trunkLean: ref.trunkLeanAngle.validity === 'VALID' ? ref.trunkLeanAngle.value : 0
        },
        last.timestamp
      )
      // 身体比例：仅用校准窗口（可信站立帧）估计并冻结，供本组模型特征使用。
      const proportionEstimate = estimate(
        frames.map((f) => ({ keypoints: f.keypoints, side, timestamp: f.timestamp })),
        this.config.proportion
      )
      result.proportion = { estimate: proportionEstimate, side, frozenAt: last.timestamp }
    }
    this.calibrationFrames = []
    return result
  }

  /**
   * 推理空结果 / 无人体 / 帧超时的统一数据失效流程：
   * 清空滤波与旧读数，进入数据不足；保留已完成次数与已保存报告。
   */
  invalidateFrame(timestamp: number): AnalysisSnapshot {
    this.filter.reset()
    const prevState = this.phase.current
    const side = this.sideSelector.side ?? 'left'
    const emptyFeatures: FrameFeatures = {
      timestamp,
      side,
      angles: EMPTY_ANGLES,
      valid: false,
      shoulderNorm: { x: 0, y: 0 },
      hipNorm: { x: 0, y: 0 }
    }
    this.phase.transition(emptyFeatures, this.config.phase)
    const nextState = this.phase.current
    if (this.running && nextState.current !== prevState.current) {
      this.counter.onPhaseChange(prevState, nextState, timestamp)
      // 无人体/推理失败与"关键点无效"保持同一分段语义：起拉中失效即丢弃未完成分段。
      if (prevState.current === 'PULLING' && nextState.current !== 'STANDING') {
        this.openAction = null
      }
    }
    this.lastTimestamp = timestamp
    const snapshot: AnalysisSnapshot = {
      phase: nextState.current,
      phaseSince: nextState.since,
      count: this.counter.value.completedCount,
      incompleteCount: this.counter.value.incompleteSegments.length,
      angles: EMPTY_ANGLES,
      side: this.sideSelector.side,
      dataValid: false,
      coverageRatio: this.totalFrames > 0 ? this.validFrames / this.totalFrames : 0,
      filteredPixels: [],
      landmarks: [],
      running: this.running
    }
    this.onUpdate(snapshot)
    return snapshot
  }

  /** 处理一帧关键点（归一化坐标 + 原始画面尺寸）。 */
  processFrame(
    landmarks: NormalizedLandmark[],
    frameSize: FrameSize,
    timestamp: number
  ): AnalysisSnapshot {
    const pixels = restorePixels(landmarks, frameSize)
    const filtered = this.filter.update(pixels, timestamp, this.config.filter)

    const leftConfidence = sideConfidence(landmarks, 'left')
    const rightConfidence = sideConfidence(landmarks, 'right')
    const selection = this.sideSelector.select(leftConfidence, rightConfidence, this.config.side)
    if (selection.switched) {
      // 可见侧切换：清理相关历史，避免跨左右拼出同一条肢体。
      this.filter.reset()
      this.phase.reset()
      this.rules.reset()
      // 跨侧的动作分段不再可信，丢弃未完成分段。
      this.openAction = null
    }

    const angles = computeAnglesFromPixels(
      filtered,
      selection.side,
      this.config.filter.confidenceThreshold
    )

    const dataValid =
      angles.trunkLeanAngle.validity === 'VALID' && angles.kneeInnerAngle.validity === 'VALID'

    if (this.calibrating) {
      this.calibrationFrames.push({ keypoints: filtered, timestamp })
    }

    const idx = LANDMARK_INDEX[selection.side]
    const shoulderNorm = { x: landmarks[idx.shoulder]?.x ?? 0, y: landmarks[idx.shoulder]?.y ?? 0 }
    const hipNorm = { x: landmarks[idx.hip]?.x ?? 0, y: landmarks[idx.hip]?.y ?? 0 }

    const features: FrameFeatures = {
      timestamp,
      side: selection.side,
      angles,
      valid: dataValid,
      shoulderNorm,
      hipNorm
    }

    if (this.running) {
      this.totalFrames += 1
      if (dataValid) this.validFrames += 1
      // 角度范围按各指标自身有效性独立统计：髋点缺失导致阶段数据无效时，
      // 仍保留手臂/肘等可信指标的范围，避免"部分不可用 = 全部不可用"。
      if (this.angleSamples.length < MAX_ANGLE_SAMPLES) this.angleSamples.push(angles)
      // 各指标独立覆盖率：与总阶段覆盖率分开统计。
      if (angles.armGroundAngle.validity === 'VALID') this.metricValidFrames.armGround += 1
      if (angles.elbowInnerAngle.validity === 'VALID') this.metricValidFrames.elbowInner += 1
      if (angles.kneeInnerAngle.validity === 'VALID') this.metricValidFrames.kneeInner += 1
      if (angles.trunkLeanAngle.validity === 'VALID') this.metricValidFrames.trunkLean += 1
      const prevState = this.phase.current
      this.phase.transition(features, this.config.phase)
      const nextState = this.phase.current
      const from = prevState.current
      const to = nextState.current
      if (to !== from) {
        this.counter.onPhaseChange(prevState, nextState, timestamp)
        const stamps = this.counter.value.actionTimestamps
        if (to === 'STANDING' && stamps.length >= 2) {
          this.actionIntervals.push(stamps[stamps.length - 1] - stamps[stamps.length - 2])
        }
        // 动作分段：进入起拉时开启；未达站直即离开起拉（下放/中断）则丢弃，不假造完整动作。
        if (to === 'PULLING' && from !== 'PULLING') {
          this.openAction = {
            index: this.actionSegments.length + 1,
            side: selection.side,
            startMs: timestamp,
            frames: [],
            timestamps: [],
            shoulderY: [],
            hipY: [],
            ankleY: []
          }
        } else if (from === 'PULLING' && to !== 'STANDING') {
          this.openAction = null
        }
      }
      if (this.openAction) {
        const idxA = LANDMARK_INDEX[selection.side]
        this.openAction.frames.push(angles)
        this.openAction.timestamps.push(timestamp)
        this.openAction.shoulderY.push(landmarks[idxA.shoulder]?.y ?? Number.NaN)
        this.openAction.hipY.push(landmarks[idxA.hip]?.y ?? Number.NaN)
        this.openAction.ankleY.push(landmarks[idxA.ankle]?.y ?? Number.NaN)
      }
      // 完成一次（起拉→稳定站直）：收尾分段；站立帧已计入本次动作。
      if (from === 'PULLING' && to === 'STANDING') {
        this.closeOpenAction(timestamp)
      }
      this.rules.update(features, nextState.current, this.config.rule)
    } else {
      // 未开始一组时也推进数据不足判定，保证读数有效性正确。
      this.phase.transition(features, this.config.phase)
    }

    this.lastTimestamp = timestamp

    const snapshot: AnalysisSnapshot = {
      phase: this.phase.current.current,
      phaseSince: this.phase.current.since,
      count: this.counter.value.completedCount,
      incompleteCount: this.counter.value.incompleteSegments.length,
      angles,
      side: selection.side,
      dataValid,
      coverageRatio: this.totalFrames > 0 ? this.validFrames / this.totalFrames : 0,
      filteredPixels: filtered,
      landmarks,
      running: this.running
    }
    this.onUpdate(snapshot)
    return snapshot
  }

  /** 结束一组并返回会话数据。 */
  end(): SessionData {
    this.running = false
    const start = this.sessionStart ?? this.lastTimestamp
    const durationSec = Math.max(0, (this.lastTimestamp - start) / 1000)
    const ratio = (n: number): number => (this.totalFrames > 0 ? n / this.totalFrames : 0)
    return {
      countRecord: this.counter.value,
      durationSec,
      validCoverageRatio: this.totalFrames > 0 ? this.validFrames / this.totalFrames : 0,
      angleRanges: aggregateAngleRanges(this.angleSamples),
      actionIntervals: this.actionIntervals,
      candidateIssues: this.rules.getIssues(this.config.rule),
      perMetricCoverage: {
        armGround: ratio(this.metricValidFrames.armGround),
        elbowInner: ratio(this.metricValidFrames.elbowInner),
        kneeInner: ratio(this.metricValidFrames.kneeInner),
        trunkLean: ratio(this.metricValidFrames.trunkLean)
      },
      perRepEvidence: this.counter.value.actionTimestamps.map((timestamp, index) => ({
        index: index + 1,
        timestamp,
        angles: EMPTY_ANGLES
      }))
    }
  }

  /**
   * 收尾当前动作分段：先裁到最低点之后的上升段（与训练端一致），
   * 再按"身高代理（踝-肩最大竖直距离）"归一化位移。
   * 退化时位移记为 NaN（缺失），不做零填充。
   */
  private closeOpenAction(endMs: number): void {
    const open = this.openAction
    this.openAction = null
    if (!open || open.frames.length === 0) return

    const startIdx = ascentStartIndex(open.frames)
    const frames = open.frames.slice(startIdx)
    const shoulderY = open.shoulderY.slice(startIdx)
    const hipY = open.hipY.slice(startIdx)
    const ankleY = open.ankleY.slice(startIdx)
    const startMs = open.timestamps[startIdx] ?? open.startMs
    if (frames.length === 0) return

    const heightCandidates: number[] = []
    for (let i = 0; i < frames.length; i += 1) {
      const ankle = ankleY[i]
      const shoulder = shoulderY[i]
      if (Number.isFinite(ankle) && Number.isFinite(shoulder)) heightCandidates.push(ankle - shoulder)
    }
    const bodyHeight = heightCandidates.length > 0 ? Math.max(...heightCandidates) : 0

    const span = (values: number[]): number => {
      const finite = values.filter((v) => Number.isFinite(v))
      if (finite.length === 0) return Number.NaN
      return Math.max(...finite) - Math.min(...finite)
    }
    const shoulderSpan = span(shoulderY)
    const hipSpan = span(hipY)
    const normalize = (v: number): number =>
      bodyHeight > 0 && Number.isFinite(v) ? v / bodyHeight : Number.NaN
    const validCount = frames.filter((a) => allAnglesValid(a)).length

    this.actionSegments.push({
      index: open.index,
      side: open.side,
      startMs,
      endMs,
      frames,
      displacement: { shoulder: normalize(shoulderSpan), hip: normalize(hipSpan) },
      validRatio: frames.length > 0 ? validCount / frames.length : 0
    })
  }

  /** 当前累计的只读计数记录（用于实时显示）。 */
  get countRecord(): CountRecord {
    return this.counter.value
  }

  /** 供报告显示的规则候选问题（不结束会话也可读取）。 */
  snapshotIssues(): ReturnType<RuleEngine['getIssues']> {
    return this.rules.getIssues(this.config.rule)
  }
}

export { createEmptyCountRecord }
