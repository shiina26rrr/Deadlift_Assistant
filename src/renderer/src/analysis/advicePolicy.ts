// 本地建议策略（v3 / T13）：规则/建议策略，**不是**训练得到的建议生成模型。
// 链路：有效观察 → 问题候选 → 证据门槛 → 合并/排序 → 中文文案。
// 约束：可行动纠错必须有有效几何观察 + 声明规则支撑；模型参考仅辅助排序/复核，不绕过门槛；
// 数据质量不足优先给机位/入框/遮挡提示；同类问题合并；不输出动作标准分/医学结论/统一合格角度。
import type {
  AdviceConfig,
  AdviceEntry,
  AdviceInput,
  AdviceItem,
  AdviceKind,
  AdviceSelection,
  CandidateIssue,
  PerMetricCoverage,
  PredictionSummary
} from '@shared/types'

/** 指标覆盖率键 → 中文标签（证据与提示展示用）。 */
const METRIC_LABEL: Record<keyof PerMetricCoverage, string> = {
  armGround: '手臂与地面夹角',
  elbowInner: '肘内角',
  kneeInner: '膝内角',
  trunkLean: '躯干倾角'
}

/**
 * 内置建议候选表：规则、门槛、优先级与中文文案集中管理，便于后续修改。
 * 文案为**中性操作提示**，不下"标准/不合格"结论，也不推导医学或安全结论。
 */
export const ADVICE_CATALOG: AdviceEntry[] = [
  {
    adviceId: 'camera-adjust',
    applicableConditions: ['有效覆盖率或关键指标覆盖率低于门槛', '入框/画面可见性不足'],
    minEvidenceMs: 0,
    minCoverage: 0,
    priority: 90,
    // 机位提示只说明"某些指标无法判断"，不否定仍可信的其他指标观察，因此不与其他建议互斥。
    text: '本组部分指标有效数据不足：请先调整机位（保持侧面、肩/髋/膝/踝完整入镜、避免遮挡）后再评价动作。'
  },
  {
    adviceId: 'elbow-bend',
    applicableConditions: ['起拉阶段肘内角持续低于阈值（有效观察）'],
    minEvidenceMs: 300,
    minCoverage: 0.5,
    priority: 80,
    mergeWith: ['elbow-bend'],
    text: '下一组留意起拉时手臂尽量保持伸直：本组起拉阶段检测到持续弯肘。'
  },
  {
    adviceId: 'arm-deviation',
    applicableConditions: ['手臂方向明显偏离垂直（有效观察）'],
    minEvidenceMs: 400,
    minCoverage: 0.5,
    priority: 60,
    text: '下一组留意手臂方向接近垂直：本组检测到手臂明显偏离垂直方向（辅助观察，不代表杠铃轨迹错误）。'
  },
  {
    adviceId: 'shoulder-hip-async',
    applicableConditions: ['肩髋上升节奏不一致（实验性观察）'],
    minEvidenceMs: 300,
    minCoverage: 0.5,
    priority: 40,
    text: '肩髋上升节奏可能不一致（实验性观察，仅供参考）。'
  }
]

export const NEUTRAL_ADVICE_ID = 'neutral-no-issue'
const NEUTRAL_TEXT =
  '本组未检测到需要改进的启发式观察项；可保持当前节奏，动作是否标准请以教练指导为准。'

/**
 * 解析候选问题依赖指标的覆盖率。
 * 一条观察依赖多个指标时必须全部达到门槛，因此取**最小值**，不能用最高覆盖率掩盖缺失指标。
 * 依赖指标均无法解析时回落整体覆盖率。
 */
function coverageForIssue(
  issue: CandidateIssue,
  coverage: PerMetricCoverage,
  fallback: number
): number {
  let worst = Number.POSITIVE_INFINITY
  for (const metric of issue.dependentMetrics) {
    const key = metric.replace(/Angle$/, '') as keyof PerMetricCoverage
    const v = coverage[key]
    if (typeof v === 'number' && Number.isFinite(v) && v < worst) worst = v
  }
  return Number.isFinite(worst) ? worst : fallback
}

interface Candidate {
  entry: AdviceEntry
  kind: AdviceKind
  evidence: string
  priority: number
  duration: number
  stage?: AdviceItem['stage']
}

/**
 * 选择本组建议：最多 2–3 条，附 `adviceId`、证据摘要与策略版本。
 * 证据不足时返回机位提示（数据不足）或中性提示（无观察），不凑数、不编造问题。
 * `model` 仅用于排序微调与复核提示，不绕过证据门槛、不生成特征不支持的问题。
 */
export function select(
  input: AdviceInput,
  model: PredictionSummary | null,
  config: AdviceConfig
): AdviceSelection {
  const policyVersion = config.policyVersion
  const maxItems = Math.max(0, Math.min(3, Math.floor(config.maxItems)))
  const insufficient = input.validCoverageRatio < config.minCoverage

  const entryById = new Map<string, AdviceEntry>()
  for (const entry of ADVICE_CATALOG) entryById.set(entry.adviceId, entry)

  const candidates: Candidate[] = []

  // 质量提示优先：覆盖率不足的指标 / 入框与可见性提示。
  const lowMetrics = (Object.keys(input.perMetricCoverage) as (keyof PerMetricCoverage)[]).filter(
    (k) => input.perMetricCoverage[k] < config.minCoverage
  )
  const qualityNotes = [...input.framingQualityHints]
  if (lowMetrics.length > 0) {
    qualityNotes.push(lowMetrics.map((k) => METRIC_LABEL[k]).join('、'))
  }
  if (insufficient || qualityNotes.length > 0) {
    const camera = entryById.get('camera-adjust')
    if (camera) {
      const detail = qualityNotes.length > 0 ? `涉及：${qualityNotes.join('；')}` : '有效覆盖率不足'
      candidates.push({
        entry: camera,
        kind: 'quality',
        evidence: `依据：${detail}；本组有效覆盖率 ${(input.validCoverageRatio * 100).toFixed(1)}%`,
        priority: camera.priority,
        duration: 0
      })
    }
  }

  // 规则观察候选：同 ruleId 合并为一条（累计持续时间）。
  // 即使总覆盖率不足，也保留依赖指标自身达标的独立观察；门槛按每条建议的依赖指标判定。
  const merged = new Map<string, { issue: CandidateIssue; duration: number }>()
  for (const issue of input.candidateIssues) {
    const cur = merged.get(issue.ruleId)
    if (cur) cur.duration += issue.duration
    else merged.set(issue.ruleId, { issue, duration: issue.duration })
  }

  for (const [ruleId, { issue, duration }] of merged) {
    const entry = entryById.get(ruleId)
    if (!entry) continue
    const coverage = coverageForIssue(issue, input.perMetricCoverage, input.validCoverageRatio)
    const threshold = Math.max(config.minCoverage, entry.minCoverage)
    if (duration < entry.minEvidenceMs || coverage < threshold) continue
    candidates.push({
      entry,
      kind: 'rule-observation',
      evidence: `依据：${issue.dependentMetrics.join('、')}；累计 ${(duration / 1000).toFixed(1)}s；来源：${issue.source}；验证：${issue.validationStatus}`,
      priority: entry.priority,
      duration,
      stage: issue.stage
    })
  }

  // 模型参考仅辅助排序：非拒判且非"无问题"类别时，轻微提升规则项排序。
  const modelBoost =
    model && model.available && !model.rejected && model.predictedClass && model.predictedClass !== 'GB'
      ? 5
      : 0

  candidates.sort((a, b) => {
    const pa = a.entry.adviceId === 'camera-adjust' ? a.priority : a.priority + modelBoost
    const pb = b.entry.adviceId === 'camera-adjust' ? b.priority : b.priority + modelBoost
    if (pb !== pa) return pb - pa
    if (b.duration !== a.duration) return b.duration - a.duration
    return a.entry.adviceId.localeCompare(b.entry.adviceId)
  })

  const selected: Candidate[] = []
  const isExcluded = (c: Candidate): boolean =>
    selected.some(
      (s) =>
        (c.entry.exclusiveWith ?? []).includes(s.entry.adviceId) ||
        (s.entry.exclusiveWith ?? []).includes(c.entry.adviceId)
    )

  for (const c of candidates) {
    if (selected.length >= maxItems) break
    if (isExcluded(c)) continue
    selected.push(c)
  }

  const items: AdviceItem[] = selected.map((c) => ({
    adviceId: c.entry.adviceId,
    kind: c.kind,
    text: c.entry.text,
    evidence: c.evidence,
    source: 'rule-policy' as const,
    stage: c.stage
  }))

  if (items.length === 0) {
    if (insufficient) {
      return { policyVersion, items, fallbackReason: 'DATA_INSUFFICIENT' }
    }
    return {
      policyVersion,
      items: [
        {
          adviceId: NEUTRAL_ADVICE_ID,
          kind: 'neutral',
          text: NEUTRAL_TEXT,
          evidence: '未触发任何启发式规则；未检测到异常不等于动作标准。',
          source: 'rule-policy'
        }
      ],
      fallbackReason: 'NO_EVIDENCE'
    }
  }

  const selection: AdviceSelection = { policyVersion, items }
  if (insufficient) selection.fallbackReason = 'DATA_INSUFFICIENT'
  return selection
}
