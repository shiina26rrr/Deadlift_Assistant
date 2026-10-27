// 集中配置：所有阈值、窗口与规则参数都在此定义，并附修改说明。
// 说明：以下数值均为"有技术原则来源、阈值待验证的启发式参数"，不是通用标准，
// 也不构成动作合格线、医学结论或训练安全评分。修改方式：直接调整本文件默认值，
// 或在界面"设置 → 高级参数"中临时覆盖（支持一键恢复默认）。
import type { AppConfig } from './types'

/** 校准算法版本（写入报告快照，供跨程序更新比较；校准算法或关键参数变更时递增）。 */
export const CALIBRATION_VERSION = 'cal-1'

/** 规则集版本（写入报告快照，供跨程序更新比较；规则或阈值变更时递增）。
 * v3：规则→建议映射与报告分区调整，递增为 rule-2。 */
export const RULE_VERSION = 'rule-2'

/** 身体比例特征版本（T12；训练与运行时必须使用同一版本，变更时递增）。 */
export const PROPORTION_FEATURE_VERSION = 'prop-1'

/** 本地建议策略版本（T13；规则/门槛/文案或互斥合并关系变更时递增）。 */
export const ADVICE_POLICY_VERSION = 'advice-1'

export const DEFAULT_CONFIG: AppConfig = {
  // 关键点帧滑动平均与过期判定。
  filter: {
    // 滑动窗口帧数：越大越平滑，但引入延迟；建议 3–9，默认 5。
    windowSize: 5,
    // 关键点置信阈值：低于该值的点不纳入平均窗口；建议 0.3–0.6，默认 0.5。
    confidenceThreshold: 0.5,
    // 数据过期时限（毫秒）：超过后相关指标显示"数据不足"，不伪装冻结旧值；默认 800ms。
    expiryMs: 800
  },

  // 阶段状态机参数。
  phase: {
    // 站立/准备稳定时间阈值（毫秒）：站立稳定超过该时长才进入 READY；默认 500ms。
    readyStableMs: 500,
    // 稳定站直时间阈值（毫秒）：起拉后稳定站直超过该时长才计一次；默认 400ms。
    standStableMs: 400,
    // 躯干前倾角变化阈值（度）：用于 READY→PULLING 判定；默认 12°。
    leanThreshold: 12,
    // 长中断阈值（毫秒）：超过后重建状态并保留中断标记；默认 3000ms。
    longInterruptMs: 3000,
    // 膝内角"接近伸直"阈值（度）：≥ 该值视为伸直；默认 160°。
    kneeExtendedDeg: 160,
    // 躯干"接近竖直"阈值（度）：≤ 该值视为站直；默认 12°。
    trunkUprightDeg: 12,
    // 躯干"明显前倾"阈值（度）：≥ 该值视为起拉/下放前倾；默认 30°。
    trunkLeaningDeg: 30,
    // 归一化位移显著性阈值：肩/髋垂直位移超过该值视为显著；默认 0.06。
    displacementThreshold: 0.06
  },

  // 启发式规则参数（阈值待验证）。
  rule: {
    // 起拉期间肘内角低于该值视为"明显弯肘"；默认 150°（接近伸直为 180°）。
    elbowBendThreshold: 150,
    // 弯肘需持续超过该时长才记录候选问题（毫秒）；默认 300ms。
    elbowBendMinDurationMs: 300,
    // 手臂与地面夹角偏离 90° 超过该值视为"明显偏离垂直"；默认 25°。
    armDeviationThreshold: 25,
    // 手臂偏离需持续超过该时长才记录（毫秒）；默认 400ms。
    armDeviationMinDurationMs: 400,
    // 肩髋上升不协调（实验性规则）：默认关闭，未充分验证前不启用确定性纠错。
    enableShoulderHipCheck: false,
    // 肩髋异步归一化位移差阈值；默认 0.05。
    shoulderHipAsyncThreshold: 0.05
  },

  // 可见侧选择。
  side: {
    // 切换滞回：另一侧置信度需超过当前侧该差值才切换，避免频繁抖动；默认 0.15。
    switchHysteresis: 0.15,
    // 最低置信度要求：低于该值视为该侧不可用；默认 0.4。
    minConfidence: 0.4,
    // 手动指定侧别；null 表示自动选择。
    manualSide: null
  },

  // 站立校准。
  calibration: {
    // 校准采集时长（毫秒）：2–3 秒；默认 2500ms。
    durationMs: 2500,
    // 姿态稳定阈值：校准窗口内角度波动标准差上限（度）；默认 6°。
    stabilityThreshold: 6,
    // 校准期间最低置信度；默认 0.5。
    minConfidence: 0.5,
    // 校准成功后到自动开始本组的倒计时秒数（v3：默认 6 秒，可设 5–7 秒）；可取消，失效不启动。
    countdownSec: 6
  },

  // 入框引导与人体位置检测（v3 新增；阈值待实测，仅用于显示层判定）。
  framing: {
    // 头顶安全余量（归一化高度）：鼻点上移估计头顶边界，鼻点在框内≠头部完整；默认 0.08。
    headMargin: 0.08,
    // 入框判定所需关键点最低置信度；低于此值视为无法确认；默认 0.4。
    minConfidence: 0.4,
    // 引导框宽度占画幅比例；默认 0.5。
    boxWidthRatio: 0.5,
    // 引导框上边距占画幅比例；默认 0.05。
    boxMarginTop: 0.05,
    // 引导框下边距占画幅比例；默认 0.05。
    boxMarginBottom: 0.05,
    // 人体高度占画幅超过该比例判定为过近；默认 0.98。
    closeHeightRatio: 0.98,
    // 人体中心水平偏离画幅中心超过该比例判定为偏左/偏右；默认 0.22。
    centerOffsetRatio: 0.22
  },

  // 身体比例估计（v2/v3 新增；单目投影近似，缺失明确降级为 MISSING）。
  proportion: {
    // 站立帧窗口（毫秒）：校准窗口内取此范围的站立帧估计比例。
    windowMs: 3000,
    // 判定 OK 所需的最小有效帧数。
    minValidFrames: 12,
    // 判定 OK 允许的最大离散度（相对 MAD）。
    maxDispersion: 0.08,
    // 参与比例计算的最小分段长度（像素，阈值待实测）；近零分母不参与，避免比例失真。
    minSegmentConfidence: 10
  },

  // 本地建议策略（v3 新增；规则/建议策略，非训练得到的建议生成模型）。
  advice: {
    // 建议策略版本（写入报告快照与建议条目来源标注）。
    policyVersion: ADVICE_POLICY_VERSION,
    // 单组最多建议条数（2–3）；默认 3。
    maxItems: 3,
    // 纳入建议所需的最低指标覆盖率；低于此值不输出该指标的纠错建议；默认 0.5。
    minCoverage: 0.5
  },

  // 在线文本润色（默认关闭）。API Key 仅会话内使用，不写入源码/日志/快照。
  online: {
    enabled: false,
    baseUrl: '',
    modelName: '',
    apiKey: '',
    // 请求超时（毫秒）；默认 15000ms。
    timeoutMs: 15000
  },

  // 整组报告。
  report: {
    // 有效覆盖率低于该比例时减少或停止评价，显示"本组数据不足"；默认 0.5。
    minCoverageForEvaluation: 0.5,
    // 最多建议条数（2–3）；默认 3。
    maxSuggestions: 3
  }
}

/** 深拷贝一份默认配置，避免调用方修改共享对象。 */
export function cloneDefaultConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig
}

/** 免责声明原文（界面固定显示，不得改写）。 */
export const DISCLAIMER =
  '本工具仅作为初学者练习辅助参考，存在算法误差，不能够替代专业健身教练，请勿直接依据该软件判断大重量训练安全性。'

/** 数据采集条件说明（界面与文档共用）。 */
export const CAPTURE_GUIDE =
  '摄像头置于训练者侧面约 2–3 米，镜头约腰部高度并保持水平，尽量呈矢状侧面；' +
  '肩、肘、腕、髋、膝、踝尽量完整入镜，照明清晰。旋转、非侧面、遮挡、宽松衣物或人体出画会降低可靠性。'

/** 资源相对路径（由渲染进程 public 目录提供，打包后同源加载）。 */
export const RESOURCE_PATHS = {
  wasmDir: 'wasm',
  model: 'models/pose_landmarker_lite.task',
  /** 本地动作模型产物（开发训练阶段导出，随包只读；缺失时报告标"仅规则分析"）。 */
  actionModel: 'models/action-model.json',
  samplesDir: 'samples'
} as const
