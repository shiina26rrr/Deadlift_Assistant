// 领域类型：与 design.md 2.2 接口设计与 2.3.2 类图严格对齐。
// 所有阈值与参数集中在 config.ts，本文件只描述结构。

/** 可见侧（矢状面侧面分析，一次动作期间保持同侧）。 */
export type Side = 'left' | 'right'

/** 动作阶段状态机的状态。 */
export type Phase =
  | 'IDLE'
  | 'READY'
  | 'PULLING'
  | 'STANDING'
  | 'LOWERING'
  | 'DATA_INSUFFICIENT'

/**
 * 入框判定状态（v3）：摄像头开场要求至少头部至脚踝完整入框，满足后才进入校准。
 * 状态对应框上方分类提示，不只靠颜色区分。
 */
export type FramingStatus =
  | 'UNDETECTED' // 未检测到人
  | 'HEAD_OUT' // 头部出画
  | 'ANKLE_OUT' // 脚踝出画
  | 'TOO_CLOSE' // 过近
  | 'SHIFT_LEFT' // 偏左
  | 'SHIFT_RIGHT' // 偏右
  | 'UNCERTAIN' // 关键点不足，无法确认
  | 'READY' // 完整入框，可校准

/** 归一化框（0–1，相对完整画面）；渲染时再映射到实际显示矩形。 */
export interface FramingBox {
  x: number
  y: number
  width: number
  height: number
}

/** 入框判定结果（纯几何，不参与测量坐标）。 */
export interface FramingState {
  status: FramingStatus
  /** 仅 READY 为 true，作为进入校准/倒计时的门槛。 */
  ready: boolean
  /** 固定竖向引导框（归一化，相对完整画面）。 */
  box: FramingBox
  /** 框上方中文提示（按状态给出具体调整方向）。 */
  message: string
  /** 观测到的人体归一化包围框；关键点不足时为 null。 */
  humanBox: FramingBox | null
}

/** 单个指标的有效性标记：不可用时不得显示 NaN 或错误值。 */
export type Validity = 'VALID' | 'UNAVAILABLE'

/** 规则验证状态：启发式参数默认待验证。 */
export type ValidationStatus = 'PENDING' | 'VALIDATED' | 'EXPERIMENTAL'

/** 还原为像素坐标后的二维点。 */
export interface Point2D {
  x: number
  y: number
  visibility: number
}

/** MediaPipe 输出的归一化关键点（0–1）。 */
export interface NormalizedLandmark {
  x: number
  y: number
  z: number
  visibility: number
}

export interface FrameSize {
  width: number
  height: number
}

export interface AngleEntry {
  value: number
  validity: Validity
}

/** 四项角度：手臂与地面夹角、肘内角、膝内角、躯干倾角。 */
export interface AngleSet {
  armGroundAngle: AngleEntry
  elbowInnerAngle: AngleEntry
  kneeInnerAngle: AngleEntry
  trunkLeanAngle: AngleEntry
}

export interface Range {
  min: number
  max: number
  valid: boolean
}

export interface AngleRangeSet {
  armGround: Range
  elbowInner: Range
  kneeInner: Range
  trunkLean: Range
}

/** 用于阶段识别的内部位移特征（归一化后）。 */
export interface Displacement {
  shoulderDelta: number
  hipDelta: number
  normalized: boolean
}

export interface TimeSegment {
  start: number
  end: number
}

export interface PhaseTransition {
  from: Phase
  to: Phase
  timestamp: number
  trigger: string
}

export interface PhaseState {
  current: Phase
  previous: Phase
  since: number
  stableDuration: number
  transitionHistory: PhaseTransition[]
}

export interface CountRecord {
  completedCount: number
  incompleteSegments: TimeSegment[]
  interruptions: TimeSegment[]
  actionTimestamps: number[]
}

export interface CalibrationFrame {
  keypoints: Point2D[]
  timestamp: number
}

export interface CalibrationReference {
  standingAngles: AngleSet
  side: Side
  capturedAt: number
}

export interface CandidateIssue {
  ruleId: string
  stage: Phase
  dependentMetrics: string[]
  params: Record<string, number>
  duration: number
  source: string
  validationStatus: ValidationStatus
  feedbackText: string
}

export interface Suggestion {
  text: string
  evidence: string
  relatedIssues: string[]
}

/** 各指标独立的有效帧覆盖率（0–1），与总阶段覆盖率分开呈现。 */
export interface PerMetricCoverage {
  armGround: number
  elbowInner: number
  kneeInner: number
  trunkLean: number
}

export interface SessionData {
  countRecord: CountRecord
  durationSec: number
  validCoverageRatio: number
  angleRanges: AngleRangeSet
  actionIntervals: number[]
  candidateIssues: CandidateIssue[]
  /** 逐次动作的指标依据（用于报告中展开查看）。 */
  perRepEvidence: RepEvidence[]
  perMetricCoverage: PerMetricCoverage
}

export interface RepEvidence {
  index: number
  timestamp: number
  angles: AngleSet
}

export interface GroupReport {
  completedCount: number
  incompleteSegments: TimeSegment[]
  durationSec: number
  validCoveragePercent: number
  angleRanges: AngleRangeSet
  rhythm: number[]
  candidateIssues: CandidateIssue[]
  /** 几何规则观察与本地建议（规则策略，最多 2–3 条）。 */
  suggestions: Suggestion[]
  dataSufficient: boolean
  perMetricCoveragePercent: PerMetricCoverage
  /** 本地动作模型参考（v3，与规则观察分区呈现）；无模型时为 null。 */
  modelReference?: ModelReference | null
  /** 生成建议所用的建议策略版本（v3 快照用）。 */
  advicePolicyVersion?: string
}

/** 训练模式：计划训练（设组数/每组次数）或自由训练。 */
export type TrainingMode = 'plan' | 'free'

/** 报告来源类型：摄像头实时 / 导入视频 / 程序内演示样本。 */
export type ReportSource = 'camera' | 'import' | 'demo'

/** 持久化到本地报告库的整组记录摘要（不含录像/关键点序列/密钥）。 */
export interface StoredReport {
  /** 稳定组 ID，幂等写入键：同 ID 覆盖更新，不新增重复组。 */
  setId: string
  /** 训练会话 ID（应用启动时生成）。 */
  sessionId: string
  /** 完成时间（epoch 毫秒）。 */
  completedAt: number
  mode: TrainingMode
  /** 组序号（1 起）。 */
  setIndex: number
  /** 目标次数；自由训练为 null。 */
  targetReps: number | null
  source: ReportSource
  completedCount: number
  durationSec: number
  validCoveragePercent: number
  /** 各指标独立的有效覆盖率快照（%），与总阶段覆盖率分开呈现。 */
  perMetricCoveragePercent: PerMetricCoverage
  /** 关键指标变化范围快照（含各指标有效性），仅用可信数据。 */
  angleRanges: AngleRangeSet
  /** 生成该报告时的校准算法版本（跨程序更新比较用）。 */
  calibrationVersion: string
  /** 生成该报告时的规则集版本（跨程序更新比较用）。 */
  ruleVersion: string
  /** 数据不足的记录保留质量标记。 */
  dataSufficient: boolean
  suggestions: string[]
  /** 在线润色附加文字；仅更新该组附加文本，不改变结构化结论或重复新增记录。 */
  polishedText?: string
  /** v3：模型/比例/建议策略版本与建议 ID/证据摘要快照（旧记录缺省为 undefined）。 */
  versionSnapshot?: ReportVersionSnapshot
  /** v3：导入视频裁切/可见性警告（不伪造头部/踝点）。 */
  framingWarnings?: string[]
}

// ---------------------------------------------------------------------------
// v3：本地动作模型参考、身体比例与建议策略类型（T11/T12/T13）
// ---------------------------------------------------------------------------

/** 模型有效性/验证状态（随产物提供，用于报告标注）。 */
export type ModelValidationStatus = 'PENDING' | 'VALIDATED' | 'EXPERIMENTAL' | 'FAILED' | 'UNTESTED'

/** 一次动作的本地模型预测摘要（v2 产物；报告快照用）。 */
export interface PredictionSummary {
  available: boolean
  modelVersion: string
  predictedClass?: string
  probabilities?: Record<string, number>
  /** 是否拒判（低置信/特征缺失/数据不足/模型不兼容/组内模式不一致）。 */
  rejected: boolean
  reason?:
    | 'DATA_INSUFFICIENT'
    | 'FEATURE_MISSING'
    | 'LOW_CONFIDENCE'
    | 'MODEL_INCOMPATIBLE'
    /** 整组动作分别支持不同类别，未达到一致性门槛：不强行归为一种确定错误。 */
    | 'MIXED_PATTERN'
  /** 整组已接受动作的类别占比（仅整组推理提供）；用于呈现类别分布，不作动作结论。 */
  classDistribution?: Record<string, number>
}

/** 报告中的"本地动作模型参考"分区（与几何规则观察分区呈现，不覆盖角度数值）。 */
export interface ModelReference {
  available: boolean
  modelVersion: string
  predictedClass?: string
  /** 拒判状态；拒判时 predictedClass 不作为结论展示。 */
  rejected: boolean
  reason?: string
  /** 与几何规则观察冲突时为 true，需人工复核，不给动作安全结论。 */
  conflictWithRules: boolean
  /** 整组动作的类别占比（有整组推理时）；仅作分布说明，不把混合动作判成单一错误。 */
  classDistribution?: Record<string, number>
  /** 中文说明（含适用限制）。 */
  note: string
}

/** 身体比例估计质量（单目投影近似，缺失保留 MISSING）。 */
export type ProportionQuality = 'OK' | 'LOW' | 'MISSING'

/** 相对身体比例估计；缺失项保留 null，不填"标准体型"。 */
export interface ProportionEstimate {
  featureVersion: string
  ratios: {
    /** 大腿/小腿。 */
    thighToShin: number | null
    /** 躯干/腿长。 */
    trunkToLeg: number | null
    /** 手臂/躯干。 */
    armToTrunk: number | null
  }
  validFrames: number
  dispersion: number
  quality: ProportionQuality
}

/** 本组冻结的身体比例参考（校准窗口内估计）。 */
export interface BodyProportionReference {
  estimate: ProportionEstimate
  side: Side
  frozenAt: number
}

// ---------------------------------------------------------------------------
// v2/v3：身体比例估计与本地动作模型（T11/T12）类型
// 说明：模型产物契约（FeatureSpec/参数布局）在开发训练阶段确定，运行时不训练。
// ---------------------------------------------------------------------------

/** 身体比例估计的输入帧：**已在原始像素坐标**、且接近侧面/站立可信的帧。 */
export interface CredibleStandingFrame {
  /** 原始像素坐标关键点（与校准窗口同一坐标系）。 */
  keypoints: Point2D[]
  side: Side
  timestamp: number
}

/** 身体比例估计配置。 */
export interface ProportionConfig {
  /** 站立帧窗口（毫秒）。 */
  windowMs: number
  /** 判定 OK 所需的最小有效帧数。 */
  minValidFrames: number
  /** 判定 OK 允许的最大离散度（相对 MAD）。 */
  maxDispersion: number
  /** 参与比例计算的最小分段长度（像素）；近零分母不参与。 */
  minSegmentConfidence: number
}

/** 统一特征规范：训练与运行时必须使用同一 `version`（E57/E68）。 */
export interface FeatureSpec {
  version: string
  /** 特征列顺序（训练/运行一致，长度即特征维度）。 */
  order: string[]
  /** 各特征单位（说明用途）。 */
  units: Record<string, string>
  /** 缺失掩码约定（如 NaN 表示缺失）。 */
  missingMaskRule: string
  window: {
    actionStatsMs: number
    normalizationRef: string
  }
}

/** 逐维标准化参数（mean/std，长度等于特征维度）。 */
export interface NormalizationParams {
  mean: number[]
  std: number[]
}

/**
 * 本地动作模型产物（随包只读，`resources/models/action-model.json`）。
 * 参数优先用可被 TypeScript 直接执行的简单格式（线性权重 + 偏置）。
 */
export interface ModelArtifactBundle {
  modelVersion: string
  featureSpec: FeatureSpec
  normalization: NormalizationParams
  /** 类别固定顺序（如 GB/PB/LLK）。 */
  classes: string[]
  /** 拒判（无法判断）阈值。 */
  rejectThreshold: number
  /** 产物完整性摘要。 */
  checksum: string
  validationStatus: ModelValidationStatus
  /** 参数：'W' 为类数×维数展平的线性权重，'b' 为各类偏置。 */
  params: Record<string, number | number[]>
}

/**
 * 一次完整动作的分段结果（供本地模型特征提取；**不参与计次**）。
 * 契约随开发训练阶段定稿，字段以管线实际可提供的信息为准。
 */
export interface SegmentedAction {
  /** 动作序号（1 起）。 */
  index: number
  side: Side
  startMs: number
  endMs: number
  /** 该次动作内逐帧角度（按时间升序；无效项已含 UNAVAILABLE）。 */
  frames: AngleSet[]
  /** 肩/髋相对身高的归一化位移幅度。 */
  displacement: { shoulder: number; hip: number }
  /** 有效帧比例（0–1）。 */
  validRatio: number
}

/** 建议策略配置（规则/建议策略，非训练得到的建议模型）。 */
export interface AdviceConfig {
  policyVersion: string
  /** 单组最多建议条数（≤3）。 */
  maxItems: number
  /** 纳入建议所需的最低指标覆盖率。 */
  minCoverage: number
}

/** 内置建议候选项定义（规则、门槛、文案集中管理，便于后续修改）。 */
export interface AdviceEntry {
  adviceId: string
  /** 触发该建议的有效观察与阶段。 */
  applicableConditions: string[]
  /** 最小证据时长（毫秒）。 */
  minEvidenceMs: number
  /** 最小覆盖率要求；低于此值不输出该建议。 */
  minCoverage: number
  /** 优先级（越大越靠前）。 */
  priority: number
  /** 互斥建议 ID。 */
  exclusiveWith?: string[]
  /** 合并建议 ID。 */
  mergeWith?: string[]
  text: string
}

/** 建议策略输入：仅使用实际可用的信息，不根据未提供的信息猜测。 */
export interface AdviceInput {
  perMetricCoverage: PerMetricCoverage
  validCoverageRatio: number
  candidateIssues: CandidateIssue[]
  proportion: BodyProportionReference | null
  /** 入框/画面可见性质量提示（摄像头与导入）。 */
  framingQualityHints: string[]
}

/**
 * 建议类型：规则观察（有几何证据的动作观察）、数据质量提示（机位/遮挡/覆盖率不足）、
 * 中性提示（无观察）。数据质量与中性提示不得当作"动作问题"参与冲突判定。
 */
export type AdviceKind = 'rule-observation' | 'quality' | 'neutral'

/** 单条建议（附稳定 adviceId 与证据摘要）。 */
export interface AdviceItem {
  adviceId: string
  kind: AdviceKind
  text: string
  evidence: string
  source: 'rule-policy'
  stage?: Phase
}

/** 建议选择结果：可少于两条或为空；附策略版本与回退原因。 */
export interface AdviceSelection {
  policyVersion: string
  items: AdviceItem[]
  fallbackReason?: string
}

/** 报告版本快照（v3 扩展，字段均用于跨程序更新比较，不静默重算历史）。 */
export interface ReportVersionSnapshot {
  calibrationVersion: string
  ruleVersion: string
  modelVersion: string
  modelPrediction: PredictionSummary | null
  proportionEstimate: ProportionEstimate | null
  proportionQuality: ProportionQuality
  proportionFeatureVersion: string
  advicePolicyVersion: string
  adviceIds: string[]
  adviceEvidence: Record<string, string>
}

/** 本地报告库文件结构（userData/reports.json）。 */
export interface ReportLibrary {
  version: number
  reports: StoredReport[]
}

/** 在线润色只接收匿名整组摘要，不含录像/截图/关键点/文件路径/个人信息。 */
export interface AnonymousSummary {
  completedCount: number
  durationSec: number
  validCoveragePercent: number
  /** 仅表示总阶段数据是否充分；不把质量不足包装成动作结论。 */
  dataSufficient: boolean
  angleRanges: AngleRangeSet
  /** 仅包含通过建议门槛筛选后的建议，不含未入选的候选问题。 */
  suggestions: Suggestion[]
}

export interface PolishResult {
  success: boolean
  polishedText?: string
  error?: string
}

export interface SampleManifestEntry {
  /** 发行包内的样本文件名（相对 resources/samples）。 */
  file: string
  originalFile: string
  source: string
  author: string
  license: string
  modified: boolean
  actualReps: number
  mainPhases: string[]
  usage: string
  usedForTuning: boolean
  /** 是否为人工拼接素材（用于多次计数测试，明确标注）。 */
  concatenated: boolean
  /** 参与者标识（尽量按参与者区分调参/验收样本）。 */
  person?: string
  /** 是否随发行包内置（false 表示需在程序内下载）。 */
  bundled?: boolean
  /** 预期字节数（下载完整性校验用）。 */
  size?: number
  /** 预期 SHA-256（下载完整性校验用）。 */
  sha256?: string
  /** 样本下载地址（程序内下载补充时使用）。 */
  downloadUrl?: string
  contentType?: string
}

/** 运行时样本信息：清单条目 + 当前可用性与存放位置。 */
export interface SampleInfo extends SampleManifestEntry {
  /** 文件存在且可用（缺失/被拦截时不标可用）。 */
  available: boolean
  /** 内置（随包只读）或用户数据目录（下载/补充）。 */
  location: 'builtin' | 'user'
}

/** 样本下载状态。 */
export type SampleDownloadState = 'idle' | 'downloading' | 'verifying' | 'done' | 'error' | 'cancelled'

/** 样本下载进度事件。 */
export interface SampleDownloadProgress {
  file: string
  state: SampleDownloadState
  received: number
  total: number
  error?: string
}

// ---------------------------------------------------------------------------
// 配置结构（阈值集中管理，详见 config.ts）
// ---------------------------------------------------------------------------

export interface FilterConfig {
  windowSize: number
  confidenceThreshold: number
  expiryMs: number
}

export interface PhaseConfig {
  readyStableMs: number
  standStableMs: number
  leanThreshold: number
  longInterruptMs: number
  /** 膝内角接近伸直判定阈值（度）。 */
  kneeExtendedDeg: number
  /** 躯干接近竖直判定阈值（度）。 */
  trunkUprightDeg: number
  /** 躯干明显前倾判定阈值（度）。 */
  trunkLeaningDeg: number
  /** 归一化后的髋/肩位移显著性阈值。 */
  displacementThreshold: number
}

export interface RuleConfig {
  elbowBendThreshold: number
  elbowBendMinDurationMs: number
  armDeviationThreshold: number
  armDeviationMinDurationMs: number
  enableShoulderHipCheck: boolean
  shoulderHipAsyncThreshold: number
}

export interface SideConfig {
  switchHysteresis: number
  minConfidence: number
  manualSide: Side | null
}

export interface CalibrationConfig {
  durationMs: number
  stabilityThreshold: number
  minConfidence: number
  /** 校准成功后到自动开始本组的倒计时秒数；可取消，失效不启动。 */
  countdownSec: number
}

/** 入框引导参数（v3，阈值待实测；仅用于显示层判定，不参与测量坐标）。 */
export interface FramingConfig {
  /** 头顶安全余量（归一化高度）：鼻点上移估计头顶边界，鼻点在框内≠头部完整。 */
  headMargin: number
  /** 入框判定所需关键点最低置信度；低于此值视为无法确认。 */
  minConfidence: number
  /** 引导框宽度占画幅比例。 */
  boxWidthRatio: number
  /** 引导框上边距占画幅比例。 */
  boxMarginTop: number
  /** 引导框下边距占画幅比例。 */
  boxMarginBottom: number
  /** 人体高度占画幅超过该比例判定为过近。 */
  closeHeightRatio: number
  /** 人体中心水平偏离画幅中心超过该比例判定为偏左/偏右。 */
  centerOffsetRatio: number
}

export interface OnlineConfig {
  enabled: boolean
  baseUrl: string
  modelName: string
  apiKey: string
  timeoutMs: number
}

export interface ReportConfig {
  /** 有效覆盖率低于该阈值时减少或停止评价。 */
  minCoverageForEvaluation: number
  maxSuggestions: number
}

export interface AppConfig {
  filter: FilterConfig
  phase: PhaseConfig
  rule: RuleConfig
  side: SideConfig
  calibration: CalibrationConfig
  /** 入框引导与人体位置检测（v3 新增）。 */
  framing: FramingConfig
  /** 身体比例估计（v2/v3 新增；单目投影近似，缺失明确降级）。 */
  proportion: ProportionConfig
  /** 本地建议策略（v3 新增；规则策略，非训练模型）。 */
  advice: AdviceConfig
  online: OnlineConfig
  report: ReportConfig
}

/** 语音可用性检查结果。 */
export interface VoiceAvailability {
  available: boolean
  voices: string[]
  error?: string
}

export type AppErrorCode =
  | 'FILE_NOT_FOUND'
  | 'UNSUPPORTED_FORMAT'
  | 'MODEL_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'DEVICE_BUSY'
  | 'DEVICE_NOT_FOUND'
  | 'TIMEOUT'
  | 'AUTH_FAILED'
  | 'FORMAT_ERROR'
  | 'NETWORK_ERROR'
  | 'NO_CHINESE_VOICE'
  | 'ENGINE_INIT_FAILED'
  | 'MODEL_NOT_LOADED'
  | 'UNKNOWN'
