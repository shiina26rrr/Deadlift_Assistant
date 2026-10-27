// 整组报告生成：汇总次数、未完成片段、时长、有效覆盖率、指标范围与节奏；
// 覆盖率不足时减少或停止评价并显示"本组数据不足"；最多 2–3 条有依据且可执行的建议。
import type {
  AdviceConfig,
  AngleRangeSet,
  AngleSet,
  BodyProportionReference,
  GroupReport,
  ModelReference,
  PredictionSummary,
  Range,
  ReportConfig,
  SessionData,
  Suggestion
} from '@shared/types'
import { select } from './advicePolicy'

function rangeOf(values: number[]): Range {
  if (values.length === 0) return { min: 0, max: 0, valid: false }
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  return { min, max, valid: true }
}

/** 汇总四项角度的变化范围（仅统计有效值）。 */
export function aggregateAngleRanges(samples: AngleSet[]): AngleRangeSet {
  const pick = (selector: (a: AngleSet) => { value: number; validity: string }): number[] =>
    samples.filter((s) => selector(s).validity === 'VALID').map((s) => selector(s).value)

  return {
    armGround: rangeOf(pick((s) => s.armGroundAngle)),
    elbowInner: rangeOf(pick((s) => s.elbowInnerAngle)),
    kneeInner: rangeOf(pick((s) => s.kneeInnerAngle)),
    trunkLean: rangeOf(pick((s) => s.trunkLeanAngle))
  }
}

/** 报告生成的可选扩展（v3）：接入本地建议策略与本地动作模型参考。 */
export interface GenerateOptions {
  /** 本地动作模型预测摘要；显式提供（含 null）时输出"模型参考"分区。 */
  model?: PredictionSummary | null
  /** 提供时启用本地建议策略链路（规则/建议策略，最多 maxItems 条）。 */
  adviceConfig?: AdviceConfig
  /** 建议链路的补充上下文（身体比例、入框/可见性提示）。 */
  adviceContext?: {
    proportion?: BodyProportionReference | null
    framingQualityHints?: string[]
  }
}

/** 类别分布的中文摘要；无分布时返回空串。 */
function distributionText(dist?: Record<string, number>): string {
  if (!dist) return ''
  const parts = Object.entries(dist)
    .filter(([, v]) => v > 0)
    .map(([cls, v]) => `${cls} ${Math.round(v * 100)}%`)
  return parts.length > 0 ? `组内类别占比：${parts.join('、')}。` : ''
}

/** 构建"本地动作模型参考"分区；缺失/失败时明确"仅规则分析"，不假称 AI 已分析。 */
function buildModelReference(model: PredictionSummary | null, hasRuleIssue: boolean): ModelReference {
  const version = model?.modelVersion ?? 'unknown'
  if (!model || !model.available) {
    return {
      available: false,
      modelVersion: version,
      rejected: false,
      conflictWithRules: false,
      note: '本地动作模型不可用：本组仅作规则分析，未使用任何模型结论。'
    }
  }
  if (model.rejected) {
    const mixed = model.reason === 'MIXED_PATTERN'
    return {
      available: true,
      modelVersion: version,
      rejected: true,
      reason: model.reason,
      conflictWithRules: false,
      ...(model.classDistribution ? { classDistribution: model.classDistribution } : {}),
      note: mixed
        ? `本地动作模型参考（${version}）：整组动作的模式不一致，未归为单一类别。${distributionText(
            model.classDistribution
          )}本组仅作规则分析，不将混合动作判为某一种确定错误。`
        : `本地动作模型已加载但拒判（${model.reason ?? '数据不足'}）：本组仅作规则分析。`
    }
  }
  const conflict = model.predictedClass === 'GB' && hasRuleIssue
  const dist = distributionText(model.classDistribution)
  const note = conflict
    ? `本地动作模型参考（${version}）预测为"${model.predictedClass}"，与几何规则观察不一致，需人工复核；不作动作标准或安全结论。${dist}`
    : `本地动作模型参考（${version}）：预测类别 ${model.predictedClass ?? '未知'}。该参考不覆盖角度数值，也不构成动作标准或安全结论。${dist}`
  return {
    available: true,
    modelVersion: version,
    predictedClass: model.predictedClass,
    rejected: false,
    conflictWithRules: conflict,
    ...(model.classDistribution ? { classDistribution: model.classDistribution } : {}),
    note
  }
}

export function generate(
  sessionData: SessionData,
  config: ReportConfig,
  options: GenerateOptions = {}
): GroupReport {
  const validCoveragePercent = Math.round(sessionData.validCoverageRatio * 1000) / 10
  const dataSufficient = sessionData.validCoverageRatio >= config.minCoverageForEvaluation
  const pct = (v: number): number => Math.round(v * 1000) / 10
  const perMetricCoveragePercent = {
    armGround: pct(sessionData.perMetricCoverage.armGround),
    elbowInner: pct(sessionData.perMetricCoverage.elbowInner),
    kneeInner: pct(sessionData.perMetricCoverage.kneeInner),
    trunkLean: pct(sessionData.perMetricCoverage.trunkLean)
  }

  let suggestions: Suggestion[] = []
  let advicePolicyVersion: string | undefined
  /** 仅"有几何证据的规则观察"计为动作问题；机位/中性提示不算。 */
  let hasRuleIssue = false

  if (options.adviceConfig) {
    // v3 建议策略链路：有效观察→候选→证据门槛→合并/排序→中文文案（规则策略）。
    const selection = select(
      {
        perMetricCoverage: sessionData.perMetricCoverage,
        validCoverageRatio: sessionData.validCoverageRatio,
        candidateIssues: sessionData.candidateIssues,
        proportion: options.adviceContext?.proportion ?? null,
        framingQualityHints: options.adviceContext?.framingQualityHints ?? []
      },
      options.model ?? null,
      options.adviceConfig
    )
    advicePolicyVersion = selection.policyVersion
    hasRuleIssue = selection.items.some((item) => item.kind === 'rule-observation')
    suggestions = selection.items.map((item) => ({
      text: item.text,
      evidence: item.evidence,
      relatedIssues: [item.adviceId]
    }))
  } else if (dataSufficient) {
    // 兼容路径：未接入建议策略时，按候选问题持续时间排序取前 N 条。
    const top = [...sessionData.candidateIssues]
      .sort((a, b) => b.duration - a.duration)
      .slice(0, config.maxSuggestions)
    suggestions = top.map((issue) => ({
      text: issue.feedbackText,
      evidence: `依据：${issue.dependentMetrics.join('、')}；累计 ${(issue.duration / 1000).toFixed(1)}s；来源：${issue.source}；验证：${issue.validationStatus}`,
      relatedIssues: [issue.ruleId]
    }))
    if (suggestions.length === 0) {
      suggestions = [
        {
          text: '本组未检测到明显的启发式观察项；可继续保持稳定节奏，动作是否标准请以教练指导为准。',
          evidence: '未触发任何启发式规则；未检测到异常不等于动作标准。',
          relatedIssues: []
        }
      ]
    }
    hasRuleIssue = suggestions.some((s) => s.relatedIssues.length > 0)
  }

  const modelProvided = Object.prototype.hasOwnProperty.call(options, 'model')

  return {
    completedCount: sessionData.countRecord.completedCount,
    incompleteSegments: sessionData.countRecord.incompleteSegments,
    durationSec: Math.round(sessionData.durationSec * 10) / 10,
    validCoveragePercent,
    angleRanges: sessionData.angleRanges,
    rhythm: sessionData.actionIntervals,
    candidateIssues: sessionData.candidateIssues,
    suggestions,
    dataSufficient,
    perMetricCoveragePercent,
    advicePolicyVersion,
    modelReference: modelProvided ? buildModelReference(options.model ?? null, hasRuleIssue) : undefined
  }
}
