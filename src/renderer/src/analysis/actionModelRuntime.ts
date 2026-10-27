// 本地动作模型运行时（v2/v3，T11）：统一特征提取 + 离线推理 + 拒判。
// 约束：**运行时不训练**、无 Python、无 API Key；以"完整一次动作"为单位；**不参与计次**；
// 特征规范版本与模型产物必须一致；低把握/特征缺失/数据不足 → 拒判，绝不假称已分析。
// 说明：特征列顺序（FEATURE_ORDER）须与开发训练脚本导出一致；契约随训练阶段定稿。
import type {
  AngleSet,
  BodyProportionReference,
  FeatureSpec,
  ModelArtifactBundle,
  PredictionSummary,
  SegmentedAction
} from '@shared/types'

/** 特征列的中文/英文名（与训练脚本约定一致）。 */
export const FEATURE_ORDER = [
  'armGroundAngle_mean',
  'armGroundAngle_min',
  'armGroundAngle_max',
  'armGroundAngle_std',
  'elbowInnerAngle_mean',
  'elbowInnerAngle_min',
  'elbowInnerAngle_max',
  'elbowInnerAngle_std',
  'kneeInnerAngle_mean',
  'kneeInnerAngle_min',
  'kneeInnerAngle_max',
  'kneeInnerAngle_std',
  'trunkLeanAngle_mean',
  'trunkLeanAngle_min',
  'trunkLeanAngle_max',
  'trunkLeanAngle_std',
  'displacementShoulder',
  'displacementHip',
  'durationSec',
  'validRatio',
  'proportionThighToShin',
  'proportionTrunkToLeg',
  'proportionArmToTrunk'
] as const

type AngleKey = 'armGroundAngle' | 'elbowInnerAngle' | 'kneeInnerAngle' | 'trunkLeanAngle'

/** 一段时间内某个角度的均值/极值/标准差；无有效值全部为 NaN（由缺失掩码表示）。 */
function angleStats(frames: AngleSet[], key: AngleKey): { mean: number; min: number; max: number; std: number } {
  const values = frames
    .map((f) => f[key])
    .filter((e) => e.validity === 'VALID' && Number.isFinite(e.value))
    .map((e) => e.value)
  if (values.length === 0) return { mean: NaN, min: NaN, max: NaN, std: NaN }
  let sum = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const v of values) {
    sum += v
    if (v < min) min = v
    if (v > max) max = v
  }
  const mean = sum / values.length
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length
  return { mean, min, max, std: Math.sqrt(variance) }
}

/**
 * 按 `spec` 的特征列顺序，从一次完整动作提取固定维度向量。
 * 缺失特征以 NaN 表示（遵循 `spec.missingMaskRule`）；动作无帧则返回 null。
 */
export function extractFeatures(
  action: SegmentedAction,
  proportion: BodyProportionReference | null,
  spec: FeatureSpec
): number[] | null {
  if (!action || action.frames.length === 0 || spec.order.length === 0) return null

  const values = new Map<string, number>()
  const put = (base: string, stats: { mean: number; min: number; max: number; std: number }): void => {
    values.set(`${base}_mean`, stats.mean)
    values.set(`${base}_min`, stats.min)
    values.set(`${base}_max`, stats.max)
    values.set(`${base}_std`, stats.std)
  }
  put('armGroundAngle', angleStats(action.frames, 'armGroundAngle'))
  put('elbowInnerAngle', angleStats(action.frames, 'elbowInnerAngle'))
  put('kneeInnerAngle', angleStats(action.frames, 'kneeInnerAngle'))
  put('trunkLeanAngle', angleStats(action.frames, 'trunkLeanAngle'))
  values.set('displacementShoulder', action.displacement.shoulder)
  values.set('displacementHip', action.displacement.hip)
  values.set('durationSec', Math.max(0, action.endMs - action.startMs) / 1000)
  values.set('validRatio', action.validRatio)
  // 比例参考质量不足（LOW/MISSING）时走缺失分支：不把单目近似包装成精确人体参数。
  const proportionOk = proportion?.estimate.quality === 'OK'
  const ratios = proportionOk ? proportion?.estimate.ratios : undefined
  values.set('proportionThighToShin', ratios?.thighToShin ?? NaN)
  values.set('proportionTrunkToLeg', ratios?.trunkToLeg ?? NaN)
  values.set('proportionArmToTrunk', ratios?.armToTrunk ?? NaN)

  return spec.order.map((name) => values.get(name) ?? NaN)
}

/** 模型是否可用于推理（形状自检；不兼容时报告按"仅规则分析"处理）。 */
export function isModelCompatible(model: ModelArtifactBundle): boolean {
  const dim = model.featureSpec?.order?.length ?? 0
  if (dim === 0) return false
  if (model.classes.length === 0) return false
  if (model.normalization.mean.length !== dim || model.normalization.std.length !== dim) return false
  const weights = model.params['W']
  return Array.isArray(weights) && weights.length === model.classes.length * dim
}

/**
 * 离线推理：标准化 → 线性打分 → softmax → 阈值拒判。
 * 低把握/特征缺失/维度不符或参数缺失 → 拒判（`reason` 明确），不输出确定性结论。
 */
export function predict(features: number[] | null, model: ModelArtifactBundle): PredictionSummary {
  const base = { available: true, modelVersion: model.modelVersion }
  const order = model.featureSpec.order
  const dim = order.length

  if (!features || features.length === 0) {
    return { ...base, rejected: true, reason: 'FEATURE_MISSING' }
  }
  if (features.length !== dim || !isModelCompatible(model)) {
    return { ...base, rejected: true, reason: 'MODEL_INCOMPATIBLE' }
  }

  const missing = features.filter((v) => !Number.isFinite(v)).length
  if (missing > dim / 2) {
    return { ...base, rejected: true, reason: 'FEATURE_MISSING' }
  }

  const { mean, std } = model.normalization
  const x = features.map((v, i) => {
    const m = mean[i]
    const s = std[i]
    const filled = Number.isFinite(v) ? v : m
    return s > 0 ? (filled - m) / s : 0
  })

  const weights = model.params['W'] as number[]
  const bias = (model.params['b'] as number[] | undefined) ?? []
  const scores = model.classes.map((_, c) => {
    let acc = bias[c] ?? 0
    for (let j = 0; j < dim; j += 1) acc += weights[c * dim + j] * x[j]
    return acc
  })
  const maxScore = Math.max(...scores)
  const exps = scores.map((s) => Math.exp(s - maxScore))
  const sum = exps.reduce((a, b) => a + b, 0) || 1
  const probabilities: Record<string, number> = {}
  let bestIdx = 0
  model.classes.forEach((cls, i) => {
    probabilities[cls] = exps[i] / sum
    if (exps[i] > exps[bestIdx]) bestIdx = i
  })

  if (probabilities[model.classes[bestIdx]] < model.rejectThreshold) {
    return { ...base, rejected: true, reason: 'LOW_CONFIDENCE', probabilities }
  }
  return { ...base, rejected: false, predictedClass: model.classes[bestIdx], probabilities }
}

/**
 * 组合入口：形状自检 → 特征提取 → 推理。
 * 模型不可用（参数缺失/形状不符/验证失败）时返回可判定的拒判摘要，供报告标"仅规则分析"。
 */
export function runInference(
  action: SegmentedAction,
  proportion: BodyProportionReference | null,
  model: ModelArtifactBundle
): PredictionSummary {
  if (model.validationStatus === 'FAILED' || !isModelCompatible(model)) {
    return {
      available: true,
      modelVersion: model.modelVersion,
      rejected: true,
      reason: 'MODEL_INCOMPATIBLE'
    }
  }
  return predict(extractFeatures(action, proportion, model.featureSpec), model)
}

/** 拒判原因中取出现次数最多者（并列时取先出现者），用于整组聚合的说明。 */
function dominantReason(summaries: PredictionSummary[]): PredictionSummary['reason'] {
  const counts = new Map<NonNullable<PredictionSummary['reason']>, number>()
  for (const s of summaries) {
    if (s.reason) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1)
  }
  let best: PredictionSummary['reason'] = 'LOW_CONFIDENCE'
  let max = -1
  for (const [reason, count] of counts) {
    if (count > max) {
      max = count
      best = reason
    }
  }
  return best
}

/**
 * 整组推理：以"本组各次完成动作"为单位分别推理，再对各次可用结果做概率平均（软投票）。
 * 无完成动作 → DATA_INSUFFICIENT；模型不可用/形状不符 → MODEL_INCOMPATIBLE；
 * 各次均拒判 → 取主要拒判原因；绝不把拒判当作已分析结论。
 */
/** 整组一致性门槛：占比最高的类别至少占已接受动作的该比例，否则视为模式不一致。 */
export const GROUP_MIN_AGREEMENT = 0.6

export function runInferenceBatch(
  actions: SegmentedAction[],
  proportion: BodyProportionReference | null,
  model: ModelArtifactBundle
): PredictionSummary {
  const base = { available: true, modelVersion: model.modelVersion }
  if (model.validationStatus === 'FAILED' || !isModelCompatible(model)) {
    return { ...base, rejected: true, reason: 'MODEL_INCOMPATIBLE' }
  }
  if (!actions || actions.length === 0) {
    return { ...base, rejected: true, reason: 'DATA_INSUFFICIENT' }
  }

  const summaries = actions.map((action) => runInference(action, proportion, model))
  const usable = summaries.filter((s) => !s.rejected && s.probabilities)
  if (usable.length === 0) {
    return { ...base, rejected: true, reason: dominantReason(summaries) }
  }

  const probabilities: Record<string, number> = {}
  for (const cls of model.classes) {
    const sum = usable.reduce((acc, s) => acc + (s.probabilities?.[cls] ?? 0), 0)
    probabilities[cls] = sum / usable.length
  }
  let best = model.classes[0]
  for (const cls of model.classes) {
    if (probabilities[cls] > probabilities[best]) best = cls
  }

  // 类别分布：按"每个动作的预测类别"计数，而不是平均后的概率。
  const counts: Record<string, number> = {}
  for (const s of usable) {
    const cls = s.predictedClass
    if (cls) counts[cls] = (counts[cls] ?? 0) + 1
  }
  const classDistribution: Record<string, number> = {}
  for (const cls of model.classes) classDistribution[cls] = (counts[cls] ?? 0) / usable.length

  // 平均概率仍需过阈值：多次中低置信不能因平均而"变成"可用结论。
  if (probabilities[best] < model.rejectThreshold) {
    return { ...base, rejected: true, reason: 'LOW_CONFIDENCE', probabilities, classDistribution }
  }
  // 组内模式不一致：不把混合动作强行归为一种确定错误。
  if (classDistribution[best] < GROUP_MIN_AGREEMENT) {
    return { ...base, rejected: true, reason: 'MIXED_PATTERN', probabilities, classDistribution }
  }
  return { ...base, rejected: false, predictedClass: best, probabilities, classDistribution }
}
