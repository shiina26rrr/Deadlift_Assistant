// UI 控制器：绑定输入、姿态分析、报告、语音与在线润色，驱动界面更新。
import type {
  AngleEntry,
  AppConfig,
  BodyProportionReference,
  FramingState,
  FramingStatus,
  GroupReport,
  ModelArtifactBundle,
  Phase,
  PredictionSummary,
  ReportSource,
  ReportVersionSnapshot,
  Side,
  StoredReport,
  TrainingMode
} from '@shared/types'
import {
  CALIBRATION_VERSION,
  PROPORTION_FEATURE_VERSION,
  RULE_VERSION
} from '@shared/config'
import { AnalysisOrchestrator, type AnalysisSnapshot } from '../analysis/orchestrator'
import { FRAMING_MESSAGE, evaluate as evaluateFraming } from '../analysis/framing'
import { validateCountdownSec } from '../analysis/countdown'
import { generate } from '../analysis/reportGenerator'
import { runInferenceBatch } from '../analysis/actionModelRuntime'
import { buildVoiceSummary, polish } from '../analysis/onlineAdapter'
import { PoseClient } from '../pose/poseClient'
import { InputManager, type InputMode } from '../input/inputManager'
import { CanvasRenderer } from '../render/canvasRenderer'
import { StateStore } from '../state/stateStore'
import { logger } from '../log/rendererLogger'

const PHASE_LABEL: Record<Phase, string> = {
  IDLE: '待准备',
  READY: '准备',
  PULLING: '起拉',
  STANDING: '站直',
  LOWERING: '下放',
  DATA_INSUFFICIENT: '数据不足'
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`缺少界面元素 #${id}`)
  return node as T
}

function formatAngle(entry: AngleEntry, unit: string): { text: string; valid: boolean } {
  if (entry.validity === 'VALID' && Number.isFinite(entry.value)) {
    return { text: `${entry.value.toFixed(0)}${unit}`, valid: true }
  }
  return { text: '不可用', valid: false }
}

/** 按本地时区归一到 YYYY-MM-DD，作为历史分组键（跨日期汇总的明确时区约定）。 */
function dayKey(ts: number): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

const SOURCE_LABEL: Record<ReportSource, string> = {
  camera: '摄像头',
  import: '导入视频',
  demo: '演示样本'
}

export class App {
  private store = new StateStore()
  private pose = new PoseClient()
  private orchestrator: AnalysisOrchestrator
  private input: InputManager
  private canvas: CanvasRenderer
  private video: HTMLVideoElement

  private videoReady = false
  private poseBusy = false
  private lastProcessAt = 0
  private lastMediaMs = -1
  private inputGeneration = 0
  private rafId = 0
  private setActive = false
  private calibrated = false
  private voiceAvailable = false
  private lastReport: GroupReport | null = null
  private lastSnapshot: AnalysisSnapshot | null = null
  private lastFraming: FramingState | null = null
  private calibrationTimer: number | null = null
  private containerObserver: ResizeObserver | null = null
  private overlayRaf = 0
  private countdownActive = false
  private countdownTimer: number | null = null
  private countdownRemaining = 0
  private autoCalibrating = false

  private trainingMode: TrainingMode = 'free'
  private planSets = 3
  private planReps = 5
  private sessionId = `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  private completedSets = 0
  private currentSetActual = 0
  private lastStoredReport: StoredReport | null = null
  private pendingSave: StoredReport | null = null
  /** 已生成载荷按组 ID 保存：异步润色回包只更新发起时的那一组。 */
  private storedPayloads = new Map<string, StoredReport>()
  /** 当前界面展示的组 ID；旧组回包不得覆盖新组画面。 */
  private currentReportSetId: string | null = null
  private loadedSource: ReportSource = 'import'
  private targetPrompted = false
  /** 本组出现过的非 READY 入框状态（供建议策略与报告可见性警告，均为真实观察不伪造）。 */
  private setFramingIssues = new Set<FramingStatus>()
  /** 本组冻结的身体比例参考（v2 产物到位前为 null）。 */
  private lastProportion: BodyProportionReference | null = null
  /** 本组本地动作模型预测摘要（无模型/均拒判时为拒判摘要，报告标"仅规则分析"）。 */
  private lastModelSummary: PredictionSummary | null = null
  /** 随包只读的本地动作模型产物；缺失/损坏时为 null（按仅规则分析处理）。 */
  private modelArtifact: ModelArtifactBundle | null = null

  private els = {
    status: el('status-text'),
    video: el<HTMLVideoElement>('video'),
    videoContainer: el('video-container'),
    videoEmpty: el('video-empty'),
    overlay: el<HTMLCanvasElement>('overlay-canvas'),
    repCount: el('rep-count'),
    incompleteCount: el('incomplete-count'),
    phaseLabel: el('phase-label'),
    sideLabel: el('side-label'),
    angleArm: el('angle-arm'),
    angleElbow: el('angle-elbow'),
    angleKnee: el('angle-knee'),
    angleTrunk: el('angle-trunk'),
    coverage: el('coverage'),
    dataQuality: el('data-quality'),
    calibrationStatus: el('calibration-status'),
    cameraSelect: el<HTMLSelectElement>('camera-select'),
    reportEmpty: el('report-empty'),
    reportContent: el('report-content'),
    reportSummary: el('report-summary'),
    reportSuggestions: el<HTMLUListElement>('report-suggestions'),
    reportEvidence: el('report-evidence'),
    onlineStatus: el('online-status'),
    polishedText: el('polished-text'),
    voiceAvailability: el('voice-availability'),
    settingsPanel: el('settings-panel'),
    helpPanel: el('help-panel'),
    videoHint: el('video-hint'),
    videoCountdown: el('video-countdown'),
    reportSection: el('report-section'),
    historyList: el('history-list'),
    trainingMode: el<HTMLSelectElement>('training-mode'),
    planConfig: el('plan-config'),
    planSets: el<HTMLInputElement>('plan-sets'),
    planReps: el<HTMLInputElement>('plan-reps'),
    planProgress: el('plan-progress'),
    saveStatus: el('save-status'),
    retrySave: el<HTMLButtonElement>('btn-retry-save'),
    viewTraining: el('view-training'),
    tabReport: el('tab-report')
  }

  constructor() {
    this.video = this.els.video
    this.orchestrator = new AnalysisOrchestrator(this.store.config, (snapshot) =>
      this.renderSnapshot(snapshot)
    )
    this.input = new InputManager(this.video, {
      onPause: () => this.handlePause(),
      onResume: () => this.handleResume(),
      onSeeking: () => this.handleSeeking(),
      onEnded: () => this.handleVideoEnded(),
      onReady: (info) => this.handleInputReady(info.mode),
      onError: (code, message) => {
        this.setStatus(`${message}（${code}）`)
        logger.error('input', `${code}: ${message}`)
      }
    })
    this.canvas = new CanvasRenderer(this.els.overlay, this.els.videoContainer)
  }

  async init(): Promise<void> {
    this.bindUi()
    this.canvas.resize()
    this.watchDpr()
    logger.info('app', '初始化开始')
    await this.refreshCameras()
    await this.loadReports()
    await this.checkVoice()
    await this.initPose()
    await this.loadActionModel()
    this.renderCalibrationState()
    this.renderPlanState()
    this.rafId = requestAnimationFrame(this.loop)
    logger.info('app', '初始化完成')
  }

  private bindUi(): void {
    // 窗口尺寸与容器尺寸变化都只登记一次 rAF，避免拖动窗口时重复绘制/抖动。
    window.addEventListener('resize', () => this.scheduleOverlayRedraw())

    // 报告展开/收起等容器尺寸变化不触发 window resize，用 ResizeObserver 跟踪。
    this.containerObserver = new ResizeObserver(() => this.scheduleOverlayRedraw())
    this.containerObserver.observe(this.els.videoContainer)

    el<HTMLButtonElement>('btn-import-video').addEventListener('click', () => void this.importVideo())
    el<HTMLButtonElement>('btn-refresh-cameras').addEventListener('click', () => void this.refreshCameras())
    el<HTMLButtonElement>('btn-open-camera').addEventListener('click', () => void this.openCamera())
    el<HTMLButtonElement>('btn-close-camera').addEventListener('click', () => this.closeCamera())
    el<HTMLButtonElement>('btn-calibrate').addEventListener('click', () => this.startCalibration())
    el<HTMLButtonElement>('btn-start-set').addEventListener('click', () => this.startSet())
    el<HTMLButtonElement>('btn-end-set').addEventListener('click', () => this.endSet())

    this.els.trainingMode.addEventListener('change', () => this.onTrainingModeChange())
    this.els.planSets.addEventListener('change', () => this.renderPlanState())
    this.els.planReps.addEventListener('change', () => this.renderPlanState())
    this.els.retrySave.addEventListener('click', () => void this.retryPendingSave())

    this.els.tabReport.addEventListener('click', () => this.scrollToReport())

    el<HTMLButtonElement>('btn-settings').addEventListener('click', () => this.openSettings())
    el<HTMLButtonElement>('btn-close-settings').addEventListener('click', () => this.els.settingsPanel.classList.add('hidden'))
    el<HTMLButtonElement>('btn-help').addEventListener('click', () => this.els.helpPanel.classList.remove('hidden'))
    el<HTMLButtonElement>('btn-close-help').addEventListener('click', () => this.els.helpPanel.classList.add('hidden'))
    el<HTMLButtonElement>('btn-save-settings').addEventListener('click', () => this.saveSettings())
    el<HTMLButtonElement>('btn-reset-defaults').addEventListener('click', () => this.resetDefaults())

    el<HTMLButtonElement>('btn-speak').addEventListener('click', () => void this.speakReport())
    el<HTMLButtonElement>('btn-stop-speak').addEventListener('click', () => void window.electronAPI.stopSpeak())
  }

  private scheduleOverlayRedraw(): void {
    if (this.overlayRaf !== 0) return
    this.overlayRaf = requestAnimationFrame(() => {
      this.overlayRaf = 0
      this.redrawOverlay()
    })
  }

  /** 尺寸/断点/DPR 变化后重算画布并重绘；必须携带 lastFraming，避免引导框短暂消失。 */
  private redrawOverlay(): void {
    this.canvas.resize()
    const frameSize = { width: this.video.videoWidth, height: this.video.videoHeight }
    if (this.lastSnapshot) {
      this.canvas.render(
        this.lastSnapshot.landmarks,
        frameSize,
        this.lastSnapshot.side,
        this.lastSnapshot.dataValid,
        this.lastFraming
      )
      return
    }
    if (this.lastFraming) {
      this.canvas.render([], frameSize, null, false, this.lastFraming)
    }
  }

  /** 系统缩放或跨屏导致 DPR 变化时，重建监听并重设画布物理像素。 */
  private watchDpr(): void {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    media.addEventListener(
      'change',
      () => {
        this.watchDpr()
        this.scheduleOverlayRedraw()
      },
      { once: true }
    )
  }

  private setStatus(text: string): void {
    this.els.status.textContent = text
  }

  private async initPose(): Promise<void> {
    this.setStatus('正在加载姿态模型…')
    logger.info('pose', '开始加载模型')
    const paths = await window.electronAPI.readModel()
    if (paths.error) {
      this.setStatus('模型文件缺失，无法进行姿态分析')
      logger.error('pose', `模型文件缺失: ${paths.error}`)
      return
    }
    const status = await this.pose.init(paths.modelPath, paths.wasmPath)
    this.store.poseBackend = status.backend
    if (status.backend === 'none') {
      this.setStatus(`姿态模型加载失败：${status.error ?? '未知错误'}`)
      logger.error('pose', `模型加载失败: ${status.error ?? '未知'}`)
    } else {
      const backend = status.backend === 'worker' ? 'Worker 推理' : '主线程推理'
      this.setStatus(`模型已加载（${backend}）`)
      logger.info('pose', `模型已加载，后端=${status.backend}`)
    }
  }

  /** 加载随包只读的本地动作模型产物；缺失/损坏时按"无模型、仅规则分析"处理。 */
  private async loadActionModel(): Promise<void> {
    try {
      this.modelArtifact = await window.electronAPI.loadModel()
    } catch (error) {
      this.modelArtifact = null
      logger.warn('model', `本地动作模型加载异常: ${(error as Error)?.message ?? '未知'}`)
    }
    if (this.modelArtifact) {
      logger.info(
        'model',
        `本地动作模型已加载: ${this.modelArtifact.modelVersion}（${this.modelArtifact.validationStatus}）`
      )
    } else {
      logger.info('model', '未找到本地动作模型产物，本组将按仅规则分析')
    }
  }

  private async refreshCameras(): Promise<void> {
    const cameras = await this.input.listCameras()
    this.els.cameraSelect.innerHTML = ''
    if (cameras.length === 0) {
      const option = document.createElement('option')
      option.value = ''
      option.textContent = '未检测到摄像头'
      this.els.cameraSelect.appendChild(option)
      return
    }
    for (const device of cameras) {
      const option = document.createElement('option')
      option.value = device.deviceId
      option.textContent = device.label || `摄像头 ${device.deviceId.slice(0, 6)}`
      this.els.cameraSelect.appendChild(option)
    }
  }

  private async checkVoice(): Promise<void> {
    const result = await window.electronAPI.checkVoiceAvailability()
    this.voiceAvailable = result.available
    this.els.voiceAvailability.textContent = result.available
      ? `可用中文语音：${result.voices.join('、')}`
      : '未检测到可用的本机中文语音；文字反馈仍可正常使用（可在系统“语音”设置中安装中文语音包）。'
  }

  private async importVideo(): Promise<void> {
    const info = await window.electronAPI.pickVideo()
    if (info.error) {
      this.setStatus('未选择视频或读取失败')
      return
    }
    await this.loadVideoUrl(info.url, 'import')
  }

  /**
   * 换源/关闭输入的统一失效：校准参考、比例、计时器、快照与组状态全部作废，
   * 并递增输入代次，使旧检测回包无法更新新输入。
   */
  private invalidateSession(): void {
    this.inputGeneration += 1
    this.cancelCountdown()
    if (this.calibrationTimer !== null) {
      window.clearTimeout(this.calibrationTimer)
      this.calibrationTimer = null
    }
    this.autoCalibrating = false
    this.calibrated = false
    this.setActive = false
    this.videoReady = false
    this.lastProportion = null
    this.lastModelSummary = null
    this.lastSnapshot = null
    this.lastFraming = null
    this.lastMediaMs = -1
    this.orchestrator.reset()
    this.canvas.clear()
  }

  private async loadVideoUrl(url: string, source: ReportSource): Promise<void> {
    this.invalidateSession()
    this.loadedSource = source
    await this.input.loadVideo(url)
  }

  private async openCamera(): Promise<void> {
    this.invalidateSession()
    this.loadedSource = 'camera'
    const deviceId = this.els.cameraSelect.value || undefined
    await this.input.openCamera(deviceId)
  }

  private closeCamera(): void {
    this.invalidateSession()
    this.input.closeCamera()
    this.els.videoEmpty.classList.remove('hidden')
    this.els.calibrationStatus.textContent = ''
    this.setStatus('摄像头已关闭')
  }

  private handleInputReady(mode: InputMode): void {
    if (mode === 'none') return
    this.videoReady = true
    this.lastMediaMs = -1
    this.els.videoEmpty.classList.add('hidden')
    this.canvas.resize()
    this.setStatus(mode === 'camera' ? '摄像头已就绪' : '视频已加载，可开始分析')
  }

  /** 视频模式用媒体时间（不受播放速度/系统时钟影响），摄像头用单调时钟。 */
  private analysisClock(): number {
    return this.input.currentMode === 'video' ? this.video.currentTime * 1000 : performance.now()
  }

  /**
   * 暂停：仅清滤波与推进中的动作，保留已完成次数、角度样本与校准参考；
   * 不结算、不清组。自然结束由 ended 单独结算。
   */
  private handlePause(): void {
    if (!this.videoReady) return
    this.cancelCalibrationInProgress()
    this.orchestrator.suspendContinuity(this.analysisClock())
    this.cancelCountdown('视频已暂停，倒计时已取消')
    this.setStatus('视频已暂停；继续播放后恢复分析，本组数据保留')
    logger.info('input', '暂停：已清时间线连续性，保留本组')
  }

  private handleResume(): void {
    if (!this.videoReady) return
    this.orchestrator.suspendContinuity(this.analysisClock())
    this.lastMediaMs = -1
    this.setStatus('继续播放')
  }

  private handleSeeking(): void {
    if (!this.videoReady) return
    this.cancelCalibrationInProgress()
    this.orchestrator.suspendContinuity(this.analysisClock())
    this.lastMediaMs = -1
    this.cancelCountdown('已跳转，倒计时已取消')
    this.setStatus('已跳转；滤波与阶段连续性已重置，本组数据保留')
    logger.info('input', '跳转：已清时间线连续性，保留本组')
  }

  /** 暂停/跳转时终止校准采集与计时，避免用冻结帧凑够站立时长。 */
  private cancelCalibrationInProgress(): void {
    const wasActive = this.calibrationTimer !== null || this.autoCalibrating
    if (this.calibrationTimer !== null) {
      window.clearTimeout(this.calibrationTimer)
      this.calibrationTimer = null
    }
    this.autoCalibrating = false
    this.orchestrator.cancelCalibration()
    if (wasActive) this.els.calibrationStatus.textContent = '校准已中断，请保持站立后重试'
  }

  private handleVideoEnded(): void {
    if (this.setActive) {
      this.endSet()
      return
    }
    this.setStatus('视频已播放结束')
  }

  private startCalibration(): void {
    if (!this.videoReady) {
      this.setStatus('请先选择输入源')
      return
    }
    this.orchestrator.beginCalibration()
    this.els.calibrationStatus.textContent = '正在采集站立参考，请保持站立…'
    const duration = this.store.config.calibration.durationMs + 200
    if (this.calibrationTimer !== null) window.clearTimeout(this.calibrationTimer)
    this.calibrationTimer = window.setTimeout(() => this.finishCalibration(), duration)
  }

  private finishCalibration(): void {
    const result = this.orchestrator.endCalibration()
    this.calibrationTimer = null
    if (result.success && result.reference) {
      this.calibrated = true
      this.lastProportion = result.proportion ?? null
      this.els.calibrationStatus.textContent = '校准完成'
      logger.info('calibration', '手动校准成功')
      this.startCountdown()
    } else {
      this.els.calibrationStatus.textContent = `校准失败：${result.reason ?? '未知原因'}`
      logger.warn('calibration', `手动校准失败: ${result.reason ?? '未知'}`)
    }
    this.renderCalibrationState()
  }

  private renderCalibrationState(): void {
    if (!this.calibrated) {
      this.els.calibrationStatus.textContent =
        this.els.calibrationStatus.textContent || '未获得站立参考，请保持站立或调整机位'
    }
  }

  private onTrainingModeChange(): void {
    this.trainingMode = this.els.trainingMode.value === 'plan' ? 'plan' : 'free'
    this.els.planConfig.classList.toggle('hidden', this.trainingMode !== 'plan')
    this.renderPlanState()
  }

  /** 读取并校验计划输入；无效返回原因，不写入。 */
  private validatePlanInputs(): { ok: true; sets: number; reps: number } | { ok: false; reason: string } {
    const sets = Number(this.els.planSets.value.trim())
    const reps = Number(this.els.planReps.value.trim())
    if (!Number.isInteger(sets) || sets < 1 || sets > 20) {
      return { ok: false, reason: '组数需为 1–20 的正整数' }
    }
    if (!Number.isInteger(reps) || reps < 1 || reps > 50) {
      return { ok: false, reason: '每组次数需为 1–50 的正整数' }
    }
    return { ok: true, sets, reps }
  }

  private renderPlanState(): void {
    if (this.trainingMode === 'free') {
      this.els.planProgress.textContent = `自由训练 ｜ 已完成 ${this.completedSets} 组`
      return
    }
    const sets = Math.floor(Number(this.els.planSets.value)) || this.planSets
    const reps = Math.floor(Number(this.els.planReps.value)) || this.planReps
    const current = Math.min(this.completedSets + 1, sets)
    const left = Math.max(0, sets - this.completedSets)
    const state = left === 0 ? '计划已完成' : `第 ${current}/${sets} 组`
    this.els.planProgress.textContent =
      `计划训练 ｜ ${state} ｜ 目标 ${reps} 次 ｜ 本组已完成 ${this.currentSetActual} 次`
  }

  /** 达到计划目标次数时提示达标，但不自动截断本组，仍由用户结束。 */
  private maybePromptTarget(count: number): void {
    if (this.targetPrompted) return
    const reps = Math.floor(Number(this.els.planReps.value)) || this.planReps
    if (count < reps) return
    this.targetPrompted = true
    this.els.planProgress.textContent = `计划训练 ｜ 已达标（目标 ${reps} 次）｜ 可结束本组`
    this.setStatus(`已达本组目标 ${reps} 次，下放站稳后点击“结束一组”`)
    logger.info('session', `达到目标次数 ${reps}，等待用户手动结束本组`)
  }

  private startSet(): void {
    this.cancelCountdownTimer()
    this.countdownActive = false
    if (!this.videoReady) {
      this.setStatus('请先选择输入源')
      return
    }
    if (this.trainingMode === 'plan') {
      const check = this.validatePlanInputs()
      if (!check.ok) {
        this.setStatus(`无法开始：${check.reason}`)
        this.els.planConfig.classList.remove('hidden')
        return
      }
      this.planSets = check.sets
      this.planReps = check.reps
      if (this.completedSets >= this.planSets) {
        this.setStatus(`计划已完成（${this.planSets} 组），如需继续请切换为自由训练`)
        return
      }
    }
    this.currentSetActual = 0
    this.targetPrompted = false
    this.setFramingIssues.clear()
    this.orchestrator.begin(this.analysisClock())
    this.setActive = true
    this.renderPlanState()
    logger.info('session', `开始一组 (mode=${this.trainingMode}, calibrated=${this.calibrated})`)
    if (!this.calibrated) {
      this.setStatus('已开始一组（尚未获得站立参考，结果可靠性有限）')
    } else {
      this.setStatus('已开始一组')
    }
    const video = this.video
    if (this.input.currentMode === 'video') void video.play().catch(() => undefined)
  }

  private endSet(): void {
    if (!this.setActive) {
      this.setStatus('当前没有进行中的一组')
      return
    }
    this.setActive = false
    const session = this.orchestrator.end()
    // 本地动作模型参考：以本组各次完成动作为单位分别推理后聚合（概率软投票）。
    // 无模型产物 → null，报告明确标注"仅规则分析"，不假称已用模型。
    this.lastModelSummary = this.modelArtifact
      ? runInferenceBatch(this.orchestrator.segmentedActions, this.lastProportion, this.modelArtifact)
      : null
    const report = generate(session, this.store.config.report, {
      model: this.lastModelSummary,
      adviceConfig: this.store.config.advice,
      adviceContext: {
        proportion: this.lastProportion,
        framingQualityHints: this.collectFramingHints()
      }
    })
    this.lastReport = report
    this.completedSets += 1
    const setId = `${this.sessionId}-set-${this.completedSets}`
    this.currentReportSetId = setId
    logger.info('session', `结束一组: 完成=${report.completedCount}, 覆盖率=${report.validCoveragePercent.toFixed(0)}%, 数据充分=${report.dataSufficient}`)
    this.showReport(report)
    this.renderPlanState()
    this.scrollToReport()
    this.persistReport(report, setId)
    void this.maybePolish(report, setId)
    void this.maybeSpeak()
  }

  /** 组结束自动落库；失败明确提示并保留可重试载荷，不假装已保存。 */
  private persistReport(report: GroupReport, setId: string): void {
    const framingWarnings = this.collectFramingHints()
    const payload: StoredReport = {
      setId,
      sessionId: this.sessionId,
      completedAt: Date.now(),
      mode: this.trainingMode,
      setIndex: this.completedSets,
      targetReps: this.trainingMode === 'plan' ? this.planReps : null,
      source: this.loadedSource,
      completedCount: report.completedCount,
      durationSec: report.durationSec,
      validCoveragePercent: report.validCoveragePercent,
      perMetricCoveragePercent: report.perMetricCoveragePercent,
      angleRanges: report.angleRanges,
      calibrationVersion: CALIBRATION_VERSION,
      ruleVersion: RULE_VERSION,
      dataSufficient: report.dataSufficient,
      suggestions: report.suggestions.map((s) => s.text),
      versionSnapshot: this.buildVersionSnapshot(report),
      framingWarnings: framingWarnings.length > 0 ? framingWarnings : undefined
    }
    this.lastStoredReport = payload
    this.storedPayloads.set(setId, payload)
    void this.writeReport(payload)
  }

  /** 本组出现过的非 READY 入框状态 → 中文可执行提示（去重，保持出现顺序）。 */
  private collectFramingHints(): string[] {
    return [...this.setFramingIssues].map((status) => FRAMING_MESSAGE[status])
  }

  /**
   * 构建报告版本快照：记录本组实际使用的算法/模型/比例/建议策略版本与建议 ID/证据，
   * 供跨程序更新比较；缺失字段如实标注（'unknown' / null / 'MISSING'），不静默重算历史。
   */
  private buildVersionSnapshot(report: GroupReport): ReportVersionSnapshot {
    const adviceIds: string[] = []
    const adviceEvidence: Record<string, string> = {}
    for (const s of report.suggestions) {
      for (const id of s.relatedIssues) {
        if (!adviceIds.includes(id)) adviceIds.push(id)
        adviceEvidence[id] = s.evidence
      }
    }
    const proportionEstimate = this.lastProportion?.estimate ?? null
    return {
      calibrationVersion: CALIBRATION_VERSION,
      ruleVersion: RULE_VERSION,
      modelVersion: report.modelReference?.modelVersion ?? 'unknown',
      modelPrediction: this.lastModelSummary,
      proportionEstimate,
      proportionQuality: proportionEstimate?.quality ?? 'MISSING',
      proportionFeatureVersion: PROPORTION_FEATURE_VERSION,
      advicePolicyVersion: report.advicePolicyVersion ?? this.store.config.advice.policyVersion,
      adviceIds,
      adviceEvidence
    }
  }

  private async writeReport(payload: StoredReport): Promise<void> {
    try {
      const result = await window.electronAPI.saveReport(payload)
      if (result.saved) {
        if (this.pendingSave?.setId === payload.setId) {
          this.pendingSave = null
          this.els.retrySave.classList.add('hidden')
        }
        if (this.currentReportSetId === payload.setId) {
          this.els.saveStatus.textContent = '本组已保存到本地记录'
          this.els.saveStatus.classList.remove('error')
          this.els.saveStatus.classList.add('ok')
        }
        await this.loadReports()
      } else {
        this.markSaveFailed(result.error ?? '未知错误', payload)
      }
    } catch (error) {
      this.markSaveFailed((error as Error)?.message ?? '写入异常', payload)
    }
  }

  private markSaveFailed(reason: string, payload: StoredReport): void {
    this.pendingSave = payload
    this.els.saveStatus.textContent = `保存失败（${reason}），可点击重试`
    this.els.saveStatus.classList.add('error')
    this.els.saveStatus.classList.remove('ok')
    this.els.retrySave.classList.remove('hidden')
    logger.warn('report', `本地保存失败: ${reason}`)
  }

  private async retryPendingSave(): Promise<void> {
    if (!this.pendingSave) return
    await this.writeReport(this.pendingSave)
  }

  private async loadReports(): Promise<void> {
    try {
      const list = (await window.electronAPI.listReports()) as StoredReport[]
      this.renderHistory(Array.isArray(list) ? list : [])
    } catch (error) {
      const message = (error as Error)?.message ?? '未知错误'
      logger.warn('report', `读取本地记录失败: ${message}`)
      // 读取失败不当作空历史：明确提示，且不触发任何覆盖写入。
      this.els.historyList.innerHTML = ''
      const failed = document.createElement('div')
      failed.className = 'history-empty'
      failed.textContent = `读取本地记录失败：${message}。原文件未被修改，请检查文件权限后重试。`
      this.els.historyList.appendChild(failed)
    }
  }

  /** 历史记录按日期分组、同页可收起查看；不触碰当前训练，不触发 AI 或播报。 */
  private renderHistory(reports: StoredReport[]): void {
    const container = this.els.historyList
    container.innerHTML = ''
    if (reports.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'history-empty'
      empty.textContent = '暂无本地记录。完成一组后会自动保存，可在此按日期回看。'
      container.appendChild(empty)
      return
    }

    const byDay = new Map<string, StoredReport[]>()
    for (const r of [...reports].sort((a, b) => b.completedAt - a.completedAt)) {
      const key = dayKey(r.completedAt)
      const arr = byDay.get(key) ?? []
      arr.push(r)
      byDay.set(key, arr)
    }

    for (const [day, dayReports] of byDay) {
      const training = dayReports.filter((r) => r.source !== 'demo')
      const totalSets = training.length
      const totalReps = training.reduce((sum, r) => sum + r.completedCount, 0)
      const totalDuration = training.reduce((sum, r) => sum + r.durationSec, 0)

      // 计划完成情况：仅统计计划模式且有目标次数的组，达标 = 实际次数 ≥ 目标。
      const planSets = training.filter((r) => r.mode === 'plan' && r.targetReps !== null)
      const planMet = planSets.filter((r) => r.completedCount >= (r.targetReps ?? Infinity)).length
      const planText = planSets.length ? ` ｜ 计划达标 ${planMet}/${planSets.length} 组` : ''

      const dayEl = document.createElement('div')
      dayEl.className = 'history-day'
      const head = document.createElement('div')
      head.className = 'history-day-head'
      head.textContent =
        `${day} ｜ 实际组数 ${totalSets} ｜ 次数 ${totalReps} ｜ 时长 ${totalDuration.toFixed(0)}s${planText}`
      dayEl.appendChild(head)

      const note = document.createElement('div')
      note.className = 'status'
      note.textContent = '（演示样本记录不计入个人训练进度；本列表按本地时区归日）'
      dayEl.appendChild(note)

      for (const r of dayReports) {
        dayEl.appendChild(this.buildHistoryItem(r))
      }
      container.appendChild(dayEl)
    }
  }

  private buildHistoryItem(r: StoredReport): HTMLElement {
    const item = document.createElement('details')
    item.className = 'history-item'
    const summary = document.createElement('summary')
    const time = new Date(r.completedAt).toLocaleTimeString('zh-CN', { hour12: false })
    const modeText = r.mode === 'plan' ? `计划（目标 ${r.targetReps ?? '—'} 次）` : '自由'
    const sourceText = SOURCE_LABEL[r.source] ?? r.source
    const quality = r.dataSufficient ? '数据充分' : '数据不足'
    summary.textContent =
      `第 ${r.setIndex} 组 ｜ ${time} ｜ ${modeText} ｜ 实际 ${r.completedCount} 次 ｜ ` +
      `时长 ${r.durationSec.toFixed(0)}s ｜ 覆盖率 ${r.validCoveragePercent.toFixed(0)}% ｜ ${sourceText} ｜ ${quality}`
    item.appendChild(summary)

    const body = document.createElement('div')
    body.className = 'history-body'

    // 各指标有效覆盖率（与总覆盖率分开，避免用总覆盖率掩盖某指标缺失）。
    const cov = r.perMetricCoveragePercent
    const covLine = document.createElement('div')
    covLine.textContent = cov
      ? `指标覆盖：手臂 ${cov.armGround.toFixed(0)}% ｜ 肘 ${cov.elbowInner.toFixed(0)}% ｜ 膝 ${cov.kneeInner.toFixed(0)}% ｜ 躯干 ${cov.trunkLean.toFixed(0)}%`
      : '指标覆盖：无数据'
    body.appendChild(covLine)

    // 关键指标变化范围（仅可信数据；不可用明确标注）。
    const ranges = r.angleRanges
    const fmtRange = (x: { min: number; max: number; valid: boolean } | undefined): string =>
      x && x.valid ? `${x.min.toFixed(0)}–${x.max.toFixed(0)}°` : '不可用'
    const rangeLine = document.createElement('div')
    rangeLine.textContent = ranges
      ? `指标范围：手臂 ${fmtRange(ranges.armGround)} ｜ 肘 ${fmtRange(ranges.elbowInner)} ｜ 膝 ${fmtRange(ranges.kneeInner)} ｜ 躯干 ${fmtRange(ranges.trunkLean)}`
      : '指标范围：无数据'
    body.appendChild(rangeLine)

    const suggestionsText = r.suggestions.length ? r.suggestions.join('；') : '无主要建议。'
    const sLine = document.createElement('div')
    sLine.textContent = `主要建议：${suggestionsText}`
    body.appendChild(sLine)
    if (r.polishedText) {
      const pLine = document.createElement('div')
      pLine.textContent = `在线润色：${r.polishedText}`
      body.appendChild(pLine)
    }
    // 保存时的版本快照：跨程序更新后回看该组当时使用的算法/模型/建议策略，不重算历史。
    if (r.versionSnapshot) {
      const v = r.versionSnapshot
      const modelText =
        v.modelPrediction && v.modelPrediction.available
          ? v.modelPrediction.rejected
            ? `模型 ${v.modelVersion}（${
                v.modelPrediction.reason === 'MIXED_PATTERN' ? '组内模式不一致，未归类' : '已拒判'
              }）`
            : `模型 ${v.modelVersion}（预测 ${v.modelPrediction.predictedClass ?? '—'}）`
          : `本地动作模型未使用（${v.modelVersion}）`
      const vLine = document.createElement('div')
      vLine.textContent =
        `版本快照：校准 ${v.calibrationVersion} ｜ 规则 ${v.ruleVersion} ｜ ${modelText} ｜ ` +
        `建议策略 ${v.advicePolicyVersion}`
      body.appendChild(vLine)
      if (v.adviceIds.length > 0) {
        const aLine = document.createElement('div')
        aLine.textContent = `采用建议项：${v.adviceIds.join('、')}`
        body.appendChild(aLine)
      }
    }
    if (r.framingWarnings && r.framingWarnings.length > 0) {
      const wLine = document.createElement('div')
      wLine.textContent = `可见性警告：${r.framingWarnings.join('；')}`
      body.appendChild(wLine)
    }
    if (r.source === 'demo') {
      const demoLine = document.createElement('div')
      demoLine.textContent = '演示样本：不计入个人训练进度。'
      body.appendChild(demoLine)
    }
    item.appendChild(body)
    return item
  }

  private async maybePolish(report: GroupReport, setId: string): Promise<void> {
    const online = this.store.config.online
    if (!online.enabled) {
      if (this.currentReportSetId === setId) {
        this.els.onlineStatus.textContent = '未启用（内置总结已给出）'
        this.els.polishedText.classList.add('hidden')
      }
      return
    }
    if (this.currentReportSetId === setId) this.els.onlineStatus.textContent = '正在获取润色文本…'
    const result = await polish(report, online)
    // 回包时界面可能已切到下一组：只更新发起请求的那一组，不覆盖当前画面。
    const stillCurrent = this.currentReportSetId === setId
    if (result.success && result.polishedText) {
      if (stillCurrent) {
        this.els.onlineStatus.textContent = '润色完成（不改变结构化结论）'
        this.els.polishedText.textContent = result.polishedText
        this.els.polishedText.classList.remove('hidden')
      }
      void this.updateStoredPolish(setId, result.polishedText)
    } else {
      if (stillCurrent) {
        this.els.onlineStatus.textContent = `润色失败（${result.error ?? '未知'}），已保留内置反馈`
        this.els.polishedText.classList.add('hidden')
      }
      logger.warn('online', `润色失败: ${result.error ?? '未知'}`)
    }
  }

  /** AI 润色只更新该组附加文字：同组 ID 幂等写入，不新增重复记录，也不改动结构化结论。 */
  private async updateStoredPolish(setId: string, text: string): Promise<void> {
    if (this.pendingSave) return
    // 使用发起请求时捕获的载荷，而不是可变的“最近一组”。
    const base = this.storedPayloads.get(setId)
    if (!base) return
    const updated: StoredReport = { ...base, polishedText: text }
    try {
      const result = await window.electronAPI.saveReport(updated)
      if (result.saved) {
        this.storedPayloads.set(setId, updated)
        if (this.lastStoredReport?.setId === setId) this.lastStoredReport = updated
        await this.loadReports()
      }
    } catch {
      // 附加文字更新失败不影响结构化报告与已保存记录。
    }
  }

  private async maybeSpeak(): Promise<void> {
    if (!this.store.voiceEnabled || !this.lastReport) return
    if (!this.voiceAvailable) {
      this.setStatus('未检测到本机中文语音，文字反馈仍可用')
      return
    }
    await window.electronAPI.speak(buildVoiceSummary(this.lastReport))
  }

  private async speakReport(): Promise<void> {
    if (!this.lastReport) return
    if (!this.voiceAvailable) {
      this.setStatus('未检测到本机中文语音')
      return
    }
    await window.electronAPI.speak(buildVoiceSummary(this.lastReport))
  }

  private renderSnapshot(snapshot: AnalysisSnapshot): void {
    this.lastSnapshot = snapshot
    this.els.repCount.textContent = String(snapshot.count)
    if (snapshot.running) {
      this.currentSetActual = snapshot.count
      if (this.trainingMode === 'plan') {
        this.renderPlanState()
        this.maybePromptTarget(snapshot.count)
      }
    }
    this.els.incompleteCount.textContent = `未完成片段 ${snapshot.incompleteCount}`
    this.els.phaseLabel.textContent = PHASE_LABEL[snapshot.phase]
    this.els.sideLabel.textContent =
      snapshot.side === 'left' ? '左侧' : snapshot.side === 'right' ? '右侧' : '—'
    this.updateAngleDisplay(this.els.angleArm, snapshot.angles.armGroundAngle, '°')
    this.updateAngleDisplay(this.els.angleElbow, snapshot.angles.elbowInnerAngle, '°')
    this.updateAngleDisplay(this.els.angleKnee, snapshot.angles.kneeInnerAngle, '°')
    this.updateAngleDisplay(this.els.angleTrunk, snapshot.angles.trunkLeanAngle, '°')
    this.els.coverage.textContent = snapshot.running
      ? `${(snapshot.coverageRatio * 100).toFixed(0)}%`
      : '—'
    this.els.dataQuality.textContent = snapshot.dataValid
      ? '数据有效'
      : '数据不足 / 遮挡或出画'
    this.updateHintBand(snapshot)
  }

  /** 视频安全区提示：入框/识别不足时在框上方醒目显示，恢复后自动收起（倒计时另有专属覆盖层）。 */
  private updateHintBand(snapshot: AnalysisSnapshot): void {
    if (this.countdownActive && snapshot.phase === 'DATA_INSUFFICIENT') {
      this.cancelCountdown('人体出画或数据不足，倒计时已取消')
      logger.warn('countdown', '倒计时因数据不足被取消')
    }
    if (this.countdownActive) {
      return
    }
    const framing = this.lastFraming
    if (this.input.currentMode === 'camera' && framing && !framing.ready && !this.setActive) {
      // 摄像头开场：完整入框后才允许校准；给出具体调整方向。
      this.showHintBand(framing.message)
    } else if (
      this.input.currentMode !== 'camera' &&
      framing &&
      !framing.ready &&
      !this.setActive &&
      !this.calibrated
    ) {
      // 导入视频：不要求用户后退，只提示画面可见性不足。
      this.showHintBand('画面可见性不足：请确认头部至脚踝完整可见')
    } else if (snapshot.running && !snapshot.dataValid) {
      this.showHintBand('数据不足：请确保肩、髋、膝、踝完整入镜')
    } else {
      this.hideHintBand()
    }
    this.maybeAutoCalibrate(snapshot)
  }

  /** 摄像头模式自动校准：阶段机确认稳定站立后采集参考，成功后进入倒计时。 */
  private maybeAutoCalibrate(snapshot: AnalysisSnapshot): void {
    if (this.input.currentMode !== 'camera') return
    if (this.calibrated || this.setActive || this.autoCalibrating || this.countdownActive) return
    // 完整入框门槛：未满足入框条件不进入校准，避免弯腰/出画时误校准。
    if (!this.lastFraming?.ready) return
    if (snapshot.phase !== 'READY') return
    this.autoCalibrating = true
    this.orchestrator.beginCalibration()
    this.els.calibrationStatus.textContent = '检测到稳定站立，正在自动校准…'
    logger.info('calibration', '自动校准开始')
    const duration = this.store.config.calibration.durationMs + 200
    if (this.calibrationTimer !== null) window.clearTimeout(this.calibrationTimer)
    this.calibrationTimer = window.setTimeout(() => this.finishAutoCalibration(), duration)
  }

  private finishAutoCalibration(): void {
    this.calibrationTimer = null
    this.autoCalibrating = false
    const result = this.orchestrator.endCalibration()
    if (result.success && result.reference) {
      this.calibrated = true
      this.lastProportion = result.proportion ?? null
      this.els.calibrationStatus.textContent = '校准完成'
      logger.info('calibration', '自动校准成功')
      this.startCountdown()
    } else {
      this.els.calibrationStatus.textContent = `自动校准失败：${result.reason ?? '未知原因'}，请保持站立重试`
      logger.warn('calibration', `自动校准失败: ${result.reason ?? '未知'}`)
    }
    this.renderCalibrationState()
  }

  /** 校准成功后默认 6 秒倒计时（可设 5–7 秒），结束自动开始本组；可被数据不足/输入变更取消。 */
  private startCountdown(): void {
    if (this.setActive) return
    const { seconds } = validateCountdownSec(this.store.config.calibration.countdownSec)
    this.countdownActive = true
    this.countdownRemaining = seconds
    this.showCountdown(seconds)
    if (this.countdownTimer !== null) window.clearInterval(this.countdownTimer)
    this.countdownTimer = window.setInterval(() => {
      this.countdownRemaining -= 1
      if (this.countdownRemaining <= 0) {
        this.cancelCountdownTimer()
        this.startSet()
      } else {
        this.showCountdown(this.countdownRemaining)
      }
    }, 1000)
  }

  private showCountdown(seconds: number): void {
    this.els.videoCountdown.textContent = String(seconds)
    this.els.videoCountdown.classList.remove('hidden')
  }

  private cancelCountdownTimer(): void {
    if (this.countdownTimer !== null) {
      window.clearInterval(this.countdownTimer)
      this.countdownTimer = null
    }
    this.els.videoCountdown.classList.add('hidden')
  }

  private cancelCountdown(reason?: string): void {
    if (!this.countdownActive) return
    this.countdownActive = false
    this.cancelCountdownTimer()
    if (reason) this.setStatus(reason)
  }

  private showHintBand(text: string): void {
    this.els.videoHint.textContent = text
    this.els.videoHint.classList.remove('hidden')
  }

  private hideHintBand(): void {
    this.els.videoHint.classList.add('hidden')
  }

  private updateAngleDisplay(node: HTMLElement, entry: AngleEntry, unit: string): void {
    const formatted = formatAngle(entry, unit)
    node.textContent = formatted.text
    node.classList.toggle('invalid', !formatted.valid)
  }

  private showReport(report: GroupReport): void {
    this.els.reportEmpty.classList.add('hidden')
    this.els.reportContent.classList.remove('hidden')

    const ranges = report.angleRanges
    // 各指标独立显示：某项不可用不应把其他仍可信的范围一起隐藏，也不能把空范围写成 0–0°。
    const fmtRange = (r: { min: number; max: number; valid: boolean }): string =>
      r.valid ? `${r.min.toFixed(0)}–${r.max.toFixed(0)}°` : '不可用'
    const rangeText =
      `手臂夹角 ${fmtRange(ranges.armGround)}，肘内角 ${fmtRange(ranges.elbowInner)}，` +
      `膝内角 ${fmtRange(ranges.kneeInner)}，躯干倾角 ${fmtRange(ranges.trunkLean)}`

    const durationText = report.durationSec.toFixed(1)
    const rhythmText = report.rhythm.length > 0
      ? `动作节奏（相邻两次间隔）：${report.rhythm.map((r) => (r / 1000).toFixed(1)).join(' / ')} s`
      : '动作节奏：数据不足'
    const pm = report.perMetricCoveragePercent
    const coverageText =
      `各指标覆盖率 — 手臂夹角 ${pm.armGround.toFixed(0)}%、肘内角 ${pm.elbowInner.toFixed(0)}%、` +
      `膝内角 ${pm.kneeInner.toFixed(0)}%、躯干倾角 ${pm.trunkLean.toFixed(0)}%`

    this.els.reportSummary.textContent =
      `完成 ${report.completedCount} 次 ｜ 时长 ${durationText}s ｜ 有效覆盖率 ${report.validCoveragePercent.toFixed(0)}% ｜ ` +
      `未完成片段 ${report.incompleteSegments.length} 个。${rhythmText}。角度变化范围：${rangeText}。${coverageText}。`

    this.els.reportSuggestions.innerHTML = ''
    if (!report.dataSufficient) {
      const li = document.createElement('li')
      li.textContent = '本组数据不足，暂不给出评价；请确保相关肢体完整入镜并重新采集。'
      this.els.reportSuggestions.appendChild(li)
    } else {
      for (const suggestion of report.suggestions) {
        const li = document.createElement('li')
        li.textContent = `${suggestion.text}（${suggestion.evidence}）`
        this.els.reportSuggestions.appendChild(li)
      }
    }
    // 本地动作模型参考：与几何规则观察分区呈现，不覆盖角度数值、不给安全结论。
    if (report.modelReference) {
      const li = document.createElement('li')
      li.textContent = `【本地动作模型参考】${report.modelReference.note}`
      this.els.reportSuggestions.appendChild(li)
    }

    this.els.reportEvidence.innerHTML = ''
    const issuesText = report.candidateIssues.length
      ? report.candidateIssues
          .map(
            (i) =>
              `${i.ruleId}：适用阶段 ${PHASE_LABEL[i.stage]}；累计 ${(i.duration / 1000).toFixed(1)}s；依赖 ${i.dependentMetrics.join('、')}；来源 ${i.source}；验证 ${i.validationStatus}`
          )
          .join('\n')
      : '未触发任何启发式规则。'
    const segmentsText = report.incompleteSegments.length
      ? report.incompleteSegments
          .map((s, idx) => `未完成片段 ${idx + 1}：${(s.start / 1000).toFixed(1)}s → ${(s.end / 1000).toFixed(1)}s`)
          .join('\n')
      : '无未完成片段。'
    const pre = document.createElement('pre')
    pre.textContent = `${issuesText}\n\n${segmentsText}`
    pre.style.whiteSpace = 'pre-wrap'
    pre.style.margin = '0'
    this.els.reportEvidence.appendChild(pre)
  }

  private scrollToReport(): void {
    this.els.reportSection.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  private openSettings(): void {
    const config = this.store.config
    el<HTMLInputElement>('set-online-enabled').checked = config.online.enabled
    el<HTMLInputElement>('set-base-url').value = config.online.baseUrl
    el<HTMLInputElement>('set-model').value = config.online.modelName
    el<HTMLInputElement>('set-api-key').value = config.online.apiKey
    el<HTMLInputElement>('set-voice').checked = this.store.voiceEnabled
    el<HTMLSelectElement>('set-side').value = config.side.manualSide ?? 'auto'
    el<HTMLInputElement>('set-countdown').value = String(config.calibration.countdownSec)
    el<HTMLInputElement>('set-confidence').value = String(config.filter.confidenceThreshold)
    el<HTMLInputElement>('set-elbow').value = String(config.rule.elbowBendThreshold)
    el<HTMLInputElement>('set-arm').value = String(config.rule.armDeviationThreshold)
    el<HTMLInputElement>('set-ready').value = String(config.phase.readyStableMs)
    el<HTMLInputElement>('set-stand').value = String(config.phase.standStableMs)
    this.els.settingsPanel.classList.remove('hidden')
  }

  private saveSettings(): void {
    const config: AppConfig = this.store.config
    config.online.enabled = el<HTMLInputElement>('set-online-enabled').checked
    config.online.baseUrl = el<HTMLInputElement>('set-base-url').value.trim()
    config.online.modelName = el<HTMLInputElement>('set-model').value.trim()
    config.online.apiKey = el<HTMLInputElement>('set-api-key').value
    this.store.voiceEnabled = el<HTMLInputElement>('set-voice').checked
    const side = el<HTMLSelectElement>('set-side').value
    config.side.manualSide = side === 'auto' ? null : (side as Side)
    const cdRaw = el<HTMLInputElement>('set-countdown').value
    const cdInput = cdRaw.trim() === '' ? NaN : Number(cdRaw)
    const cd = validateCountdownSec(cdInput)
    config.calibration.countdownSec = cd.seconds
    config.filter.confidenceThreshold = Number(el<HTMLInputElement>('set-confidence').value) || config.filter.confidenceThreshold
    config.rule.elbowBendThreshold = Number(el<HTMLInputElement>('set-elbow').value) || config.rule.elbowBendThreshold
    config.rule.armDeviationThreshold = Number(el<HTMLInputElement>('set-arm').value) || config.rule.armDeviationThreshold
    config.phase.readyStableMs = Number(el<HTMLInputElement>('set-ready').value) || config.phase.readyStableMs
    config.phase.standStableMs = Number(el<HTMLInputElement>('set-stand').value) || config.phase.standStableMs

    this.store.persist()
    this.orchestrator.updateConfig(config)
    this.els.settingsPanel.classList.add('hidden')
    this.setStatus(cd.ok ? '设置已保存' : '倒计时需为 5–7 秒，已使用默认 6 秒')
  }

  private resetDefaults(): void {
    this.store.resetToDefaults()
    this.orchestrator.updateConfig(this.store.config)
    this.els.settingsPanel.classList.add('hidden')
    this.setStatus('已恢复默认参数')
  }

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop)
    const video = this.video
    if (!this.videoReady || video.readyState < 2 || video.videoWidth === 0) return
    // 暂停时冻结帧不再分析，避免用同一画面累计站立时长或重复计次。
    if (this.input.currentMode === 'video' && video.paused) return
    const now = performance.now()
    if (now - this.lastProcessAt < 55 || this.poseBusy) return

    // 视频只用媒体时间推进分析；同一媒体时刻不重复分析（冻结帧）。
    let analysisTs = now
    if (this.input.currentMode === 'video') {
      const mediaMs = video.currentTime * 1000
      if (!(mediaMs > this.lastMediaMs + 0.5)) return
      this.lastMediaMs = mediaMs
      analysisTs = mediaMs
    }

    const generation = this.inputGeneration
    this.lastProcessAt = now
    this.poseBusy = true
    createImageBitmap(video)
      .then((bitmap) => this.pose.detect(bitmap, now))
      .then((landmarks) => {
        // 输入已切换：丢弃旧输入迟到的检测结果。
        if (generation !== this.inputGeneration) return
        const frameSize = { width: video.videoWidth, height: video.videoHeight }
        if (!landmarks || landmarks.length === 0) {
          // 无人体/空结果：统一数据失效流程，清空旧读数而非保留；引导框仍显示"未检测到人"。
          this.orchestrator.invalidateFrame(analysisTs)
          const framing = evaluateFraming([], this.store.config.framing, frameSize)
          this.lastFraming = framing
          if (this.setActive && !framing.ready) this.setFramingIssues.add(framing.status)
          this.canvas.render([], frameSize, null, false, framing)
          return
        }
        const framing = evaluateFraming(landmarks, this.store.config.framing, frameSize)
        this.lastFraming = framing
        if (this.setActive && !framing.ready) this.setFramingIssues.add(framing.status)
        const snapshot = this.orchestrator.processFrame(landmarks, frameSize, analysisTs)
        this.canvas.render(snapshot.landmarks, frameSize, snapshot.side, snapshot.dataValid, framing)
      })
      .catch(() => undefined)
      .finally(() => {
        this.poseBusy = false
      })
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId)
    cancelAnimationFrame(this.overlayRaf)
    if (this.calibrationTimer !== null) window.clearTimeout(this.calibrationTimer)
    this.containerObserver?.disconnect()
    this.pose.close()
    this.input.closeCamera()
  }
}
