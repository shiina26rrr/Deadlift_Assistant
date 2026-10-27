// 本地动作模型产物的读取校验（纯逻辑，主进程与测试共用）。
// 只用可被 TypeScript 直接执行的简单参数格式；形状/维度不符或字段缺失 → 返回 null（按"仅规则分析"处理）。
import type {
  FeatureSpec,
  ModelArtifactBundle,
  ModelValidationStatus,
  NormalizationParams
} from './types'

const VALIDATION_STATUSES: ModelValidationStatus[] = [
  'PENDING',
  'VALIDATED',
  'EXPERIMENTAL',
  'FAILED',
  'UNTESTED'
]

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x))
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0)
}

function sanitizeFeatureSpec(value: unknown): FeatureSpec | null {
  if (!value || typeof value !== 'object') return null
  const s = value as Partial<FeatureSpec>
  if (typeof s.version !== 'string' || !s.version) return null
  if (!isStringArray(s.order) || s.order.length === 0) return null
  if (!s.units || typeof s.units !== 'object') return null
  if (typeof s.missingMaskRule !== 'string') return null
  if (!s.window || typeof s.window !== 'object') return null
  if (typeof s.window.actionStatsMs !== 'number' || !Number.isFinite(s.window.actionStatsMs)) return null
  if (typeof s.window.normalizationRef !== 'string') return null
  return {
    version: s.version,
    order: [...s.order],
    units: { ...s.units },
    missingMaskRule: s.missingMaskRule,
    window: { actionStatsMs: s.window.actionStatsMs, normalizationRef: s.window.normalizationRef }
  }
}

/**
 * 校验并归一化模型产物。
 * 返回 null 表示产物缺失/损坏/形状不符（调用方按"无模型、仅规则分析"处理，不静默降级为假预测）。
 */
export function sanitizeModelArtifact(value: unknown): ModelArtifactBundle | null {
  if (!value || typeof value !== 'object') return null
  const m = value as Partial<ModelArtifactBundle>
  if (typeof m.modelVersion !== 'string' || !m.modelVersion) return null

  const featureSpec = sanitizeFeatureSpec(m.featureSpec)
  if (!featureSpec) return null
  const dim = featureSpec.order.length

  const normalization = m.normalization as Partial<NormalizationParams> | undefined
  if (!normalization || !isNumberArray(normalization.mean) || !isNumberArray(normalization.std)) {
    return null
  }
  if (normalization.mean.length !== dim || normalization.std.length !== dim) return null

  if (!isStringArray(m.classes) || m.classes.length === 0) return null
  if (typeof m.rejectThreshold !== 'number' || !Number.isFinite(m.rejectThreshold)) return null
  if (m.rejectThreshold < 0 || m.rejectThreshold > 1) return null
  if (typeof m.checksum !== 'string') return null
  if (!VALIDATION_STATUSES.includes(m.validationStatus as ModelValidationStatus)) return null

  if (!m.params || typeof m.params !== 'object') return null
  const weights = m.params['W']
  if (!isNumberArray(weights) || weights.length !== m.classes.length * dim) return null
  const bias = m.params['b']
  if (bias !== undefined && (!isNumberArray(bias) || bias.length !== m.classes.length)) return null

  return {
    modelVersion: m.modelVersion,
    featureSpec,
    normalization: { mean: [...normalization.mean], std: [...normalization.std] },
    classes: [...m.classes],
    rejectThreshold: m.rejectThreshold,
    checksum: m.checksum,
    validationStatus: m.validationStatus as ModelValidationStatus,
    params: { ...m.params }
  }
}
