// 本地报告库的纯逻辑（不依赖 Electron/文件系统），便于单元测试与主进程复用。
// 只存必要报告摘要：不存录像、完整关键点序列、API Key 或其他秘密。
import type {
  AngleRangeSet,
  PerMetricCoverage,
  PredictionSummary,
  ProportionEstimate,
  ProportionQuality,
  Range,
  ReportLibrary,
  ReportVersionSnapshot,
  StoredReport
} from './types'

export const LIBRARY_VERSION = 1
const UNKNOWN_VERSION = 'unknown'

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 归一化模型预测摘要；缺失或非法返回 null（旧记录不移入假预测）。 */
function normalizePredictionSummary(value: unknown): PredictionSummary | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Partial<PredictionSummary>
  if (typeof o.available !== 'boolean') return null
  if (typeof o.modelVersion !== 'string') return null
  if (typeof o.rejected !== 'boolean') return null
  const probabilities =
    o.probabilities && typeof o.probabilities === 'object'
      ? Object.fromEntries(
          Object.entries(o.probabilities).filter(([, v]) => isFiniteNumber(v))
        )
      : undefined
  const reason =
    o.reason === 'DATA_INSUFFICIENT' ||
    o.reason === 'FEATURE_MISSING' ||
    o.reason === 'LOW_CONFIDENCE' ||
    o.reason === 'MODEL_INCOMPATIBLE' ||
    o.reason === 'MIXED_PATTERN'
      ? o.reason
      : undefined
  const classDistribution =
    o.classDistribution && typeof o.classDistribution === 'object'
      ? Object.fromEntries(
          Object.entries(o.classDistribution).filter(([, v]) => isFiniteNumber(v))
        )
      : undefined
  return {
    available: o.available,
    modelVersion: o.modelVersion,
    predictedClass: typeof o.predictedClass === 'string' ? o.predictedClass : undefined,
    probabilities: probabilities && Object.keys(probabilities).length > 0 ? probabilities : undefined,
    rejected: o.rejected,
    reason,
    classDistribution:
      classDistribution && Object.keys(classDistribution).length > 0 ? classDistribution : undefined
  }
}

/** 归一化身体比例估计；缺失或非法返回 null。缺失比例项保留 null，不填标准值。 */
function normalizeProportionEstimate(value: unknown): ProportionEstimate | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Partial<ProportionEstimate>
  if (typeof o.featureVersion !== 'string') return null
  if (!o.ratios || typeof o.ratios !== 'object') return null
  const quality: ProportionQuality =
    o.quality === 'OK' || o.quality === 'LOW' || o.quality === 'MISSING' ? o.quality : 'MISSING'
  const numOrNull = (v: unknown): number | null => (isFiniteNumber(v) ? v : null)
  return {
    featureVersion: o.featureVersion,
    ratios: {
      thighToShin: numOrNull(o.ratios.thighToShin),
      trunkToLeg: numOrNull(o.ratios.trunkToLeg),
      armToTrunk: numOrNull(o.ratios.armToTrunk)
    },
    validFrames: isFiniteNumber(o.validFrames) ? o.validFrames : 0,
    dispersion: isFiniteNumber(o.dispersion) ? o.dispersion : 0,
    quality
  }
}

/**
 * 归一化版本快照：缺失时返回 undefined（不静默重算历史结论）。
 * 存在时逐字段补默认（版本 'unknown'、质量 'MISSING'、数组/映射为空），保证结构完整。
 */
function normalizeVersionSnapshot(value: unknown): ReportVersionSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const o = value as Partial<ReportVersionSnapshot>
  const proportionQuality: ProportionQuality =
    o.proportionQuality === 'OK' || o.proportionQuality === 'LOW' || o.proportionQuality === 'MISSING'
      ? o.proportionQuality
      : 'MISSING'
  const adviceEvidence =
    o.adviceEvidence && typeof o.adviceEvidence === 'object'
      ? Object.fromEntries(
          Object.entries(o.adviceEvidence).filter(([, v]) => typeof v === 'string')
        ) as Record<string, string>
      : {}
  return {
    calibrationVersion:
      typeof o.calibrationVersion === 'string' ? o.calibrationVersion : UNKNOWN_VERSION,
    ruleVersion: typeof o.ruleVersion === 'string' ? o.ruleVersion : UNKNOWN_VERSION,
    modelVersion: typeof o.modelVersion === 'string' ? o.modelVersion : UNKNOWN_VERSION,
    modelPrediction: normalizePredictionSummary(o.modelPrediction),
    proportionEstimate: normalizeProportionEstimate(o.proportionEstimate),
    proportionQuality,
    proportionFeatureVersion:
      typeof o.proportionFeatureVersion === 'string' ? o.proportionFeatureVersion : UNKNOWN_VERSION,
    advicePolicyVersion:
      typeof o.advicePolicyVersion === 'string' ? o.advicePolicyVersion : UNKNOWN_VERSION,
    adviceIds: Array.isArray(o.adviceIds)
      ? o.adviceIds.filter((id): id is string => typeof id === 'string')
      : [],
    adviceEvidence
  }
}

/** 归一化入框/可见性警告；缺失或非法返回 undefined（不伪造警告）。 */
function normalizeFramingWarnings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const warnings = value.filter((w): w is string => typeof w === 'string' && w.length > 0)
  return warnings.length > 0 ? warnings : undefined
}

/** 归一化各指标覆盖率；缺失（旧记录）填 0，保证结构完整。 */
function normalizeCoverage(value: unknown): PerMetricCoverage {
  const o = (value ?? {}) as Partial<PerMetricCoverage>
  return {
    armGround: isFiniteNumber(o.armGround) ? o.armGround : 0,
    elbowInner: isFiniteNumber(o.elbowInner) ? o.elbowInner : 0,
    kneeInner: isFiniteNumber(o.kneeInner) ? o.kneeInner : 0,
    trunkLean: isFiniteNumber(o.trunkLean) ? o.trunkLean : 0
  }
}

/** 归一化单个角度范围；缺 min/max 或 valid 非真时标为不可用。 */
function normalizeRange(value: unknown): Range {
  const o = (value ?? {}) as Partial<Range>
  const hasBounds = isFiniteNumber(o.min) && isFiniteNumber(o.max)
  return {
    min: isFiniteNumber(o.min) ? o.min : 0,
    max: isFiniteNumber(o.max) ? o.max : 0,
    valid: o.valid === true && hasBounds
  }
}

function normalizeRanges(value: unknown): AngleRangeSet {
  const o = (value ?? {}) as Partial<AngleRangeSet>
  return {
    armGround: normalizeRange(o.armGround),
    elbowInner: normalizeRange(o.elbowInner),
    kneeInner: normalizeRange(o.kneeInner),
    trunkLean: normalizeRange(o.trunkLean)
  }
}

export function emptyLibrary(): ReportLibrary {
  return { version: LIBRARY_VERSION, reports: [] }
}

/**
 * 解析库文件内容，处理版本迁移：
 * - 无库文件、空内容或非法结构时由调用方按“空库”处理（不静默丢历史）。
 * - 缺少 version 或旧结构时迁移为当前版本，保留既有合法记录。
 * 返回 null 表示内容损坏，调用方应备份后重建空库。
 */
export function parseLibrary(raw: string): ReportLibrary | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ReportLibrary>
    if (!parsed || !Array.isArray(parsed.reports)) return null
    // 逐条迁移：旧记录缺快照字段时补默认值，核心字段不全的脏记录丢弃。
    const reports = parsed.reports
      .map((r) => sanitizeReport(r))
      .filter((r): r is StoredReport => r !== null)
    return { version: LIBRARY_VERSION, reports }
  } catch {
    return null
  }
}

/** 校验并归一化报告：核心字段不全则拒绝；快照字段缺失时补默认（兼容旧记录）。 */
export function sanitizeReport(input: unknown): StoredReport | null {
  if (!input || typeof input !== 'object') return null
  const r = input as Record<string, unknown>
  if (typeof r.setId !== 'string' || !r.setId) return null
  if (typeof r.sessionId !== 'string' || !r.sessionId) return null
  if (!isFiniteNumber(r.completedAt)) return null
  if (r.mode !== 'plan' && r.mode !== 'free') return null
  if (!isFiniteNumber(r.setIndex)) return null
  if (r.targetReps !== null && !isFiniteNumber(r.targetReps)) return null
  if (r.source !== 'camera' && r.source !== 'import' && r.source !== 'demo') return null
  if (!isFiniteNumber(r.completedCount)) return null
  if (!isFiniteNumber(r.durationSec)) return null
  if (!isFiniteNumber(r.validCoveragePercent)) return null
  if (typeof r.dataSufficient !== 'boolean') return null
  if (!Array.isArray(r.suggestions)) return null
  return {
    setId: r.setId,
    sessionId: r.sessionId,
    completedAt: r.completedAt,
    mode: r.mode,
    setIndex: r.setIndex,
    targetReps: r.targetReps,
    source: r.source,
    completedCount: r.completedCount,
    durationSec: r.durationSec,
    validCoveragePercent: r.validCoveragePercent,
    perMetricCoveragePercent: normalizeCoverage(r.perMetricCoveragePercent),
    angleRanges: normalizeRanges(r.angleRanges),
    calibrationVersion:
      typeof r.calibrationVersion === 'string' ? r.calibrationVersion : UNKNOWN_VERSION,
    ruleVersion: typeof r.ruleVersion === 'string' ? r.ruleVersion : UNKNOWN_VERSION,
    dataSufficient: r.dataSufficient,
    suggestions: r.suggestions.filter((s): s is string => typeof s === 'string'),
    polishedText: typeof r.polishedText === 'string' ? r.polishedText : undefined,
    versionSnapshot: normalizeVersionSnapshot(r.versionSnapshot),
    framingWarnings: normalizeFramingWarnings(r.framingWarnings)
  }
}

/** 以组 ID 幂等合并：同 ID 覆盖更新，否则追加；返回新对象，不改动入参。 */
export function mergeReport(lib: ReportLibrary, report: StoredReport): ReportLibrary {
  const reports = [...lib.reports]
  const idx = reports.findIndex((r) => r.setId === report.setId)
  if (idx >= 0) {
    reports[idx] = report
  } else {
    reports.push(report)
  }
  return { version: LIBRARY_VERSION, reports }
}
