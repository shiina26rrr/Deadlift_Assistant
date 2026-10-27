// 在线润色提示与事实一致性校验（纯函数，便于单独测试，不依赖 Electron）。
// 原则：只发送已通过建议门槛筛选的事实；润色不得新增事实、改动数值或给出无依据结论。
import type { AnonymousSummary, Range } from '../shared/types'

export const POLISH_SYSTEM_PROMPT =
  '你是硬拉训练反馈的文字编辑助手。请在不改变任何数值、次数、结论与验证状态的前提下，' +
  '把给定的整组摘要润色为简洁中文。禁止新增无法由数据支持的错误判断，禁止给出负重安全、' +
  '疾病或医学建议，禁止把启发式阈值表述为通用标准。只返回润色后的段落正文。'

/** 无效范围写"不可用"，不能把空范围的 0–0° 当作观测值发送。 */
function formatRange(range: Range): string {
  return range.valid ? `${range.min.toFixed(0)}–${range.max.toFixed(0)}°` : '不可用'
}

/**
 * 仅使用筛选后的建议与可核对数值构建提示词。
 * 不再附带未入选的候选问题，避免润色把本地已拒绝的观察重新讲出来。
 */
export function buildUserPrompt(payload: AnonymousSummary): string {
  const suggestionLines = payload.suggestions
    .map((s) => `- ${s.text}（依据：${s.evidence}）`)
    .join('\n')
  return [
    `完成次数：${payload.completedCount}`,
    `组时长：${payload.durationSec.toFixed(1)} 秒`,
    `有效数据覆盖率：${payload.validCoveragePercent.toFixed(0)}%`,
    `数据充分性：${payload.dataSufficient ? '总阶段数据充足' : '总阶段数据不足，不给出动作评价'}`,
    `四项角度变化范围：手臂夹角 ${formatRange(payload.angleRanges.armGround)}，` +
      `肘内角 ${formatRange(payload.angleRanges.elbowInner)}，` +
      `膝内角 ${formatRange(payload.angleRanges.kneeInner)}，` +
      `躯干倾角 ${formatRange(payload.angleRanges.trunkLean)}`,
    suggestionLines ? `内置建议：\n${suggestionLines}` : '无内置建议。',
    '',
    '请保持以上数值与结论不变，输出一段简洁的中文整组反馈。'
  ].join('\n')
}

/** 不允许在润色文本中出现的无依据结论（医学/安全/动作标准）。 */
const FORBIDDEN_CLAIMS = /(动作标准(?!请)|标准分|腰椎|受伤|诊断|疾病|医学结论|绝对安全|保证安全)/

function numericTokens(text: string): string[] {
  return text.match(/\d+(?:\.\d+)?/g) ?? []
}

/**
 * 允许出现的数值集合：只包含本次摘要中的确定性事实，以及已筛选建议自身的数值。
 * 润色若改写数值或引入新数值，将不在集合中。
 */
function allowedNumbers(payload: AnonymousSummary): Set<string> {
  const allowed = new Set<string>()
  const add = (value: number): void => {
    if (!Number.isFinite(value)) return
    allowed.add(String(value))
    allowed.add(value.toFixed(0))
    allowed.add(value.toFixed(1))
  }
  add(payload.completedCount)
  add(payload.durationSec)
  add(payload.validCoveragePercent)
  for (const range of Object.values(payload.angleRanges)) {
    if (!range.valid) continue
    add(range.min)
    add(range.max)
  }
  const factText = payload.suggestions.map((s) => `${s.text} ${s.evidence}`).join(' ')
  for (const token of numericTokens(factText)) allowed.add(token)
  return allowed
}

/**
 * 事实一致性检查：
 * - 必须保留完成次数、组时长与覆盖率；
 * - 文本中的每个数值都必须来自摘要事实（拒绝改数值/新事实）；
 * - 拒绝医学、安全或"动作标准"等无依据结论；
 * - 数据不足时不得声称数据充足。
 */
export function checkConsistency(text: string, payload: AnonymousSummary): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 4) return false
  if (FORBIDDEN_CLAIMS.test(trimmed)) return false

  const tokens = numericTokens(trimmed)
  const allowed = allowedNumbers(payload)
  if (tokens.some((token) => !allowed.has(token))) return false

  if (!tokens.includes(String(payload.completedCount))) return false
  const duration = payload.durationSec
  if (!tokens.includes(duration.toFixed(1)) && !tokens.includes(duration.toFixed(0))) return false
  const coverage = payload.validCoveragePercent
  if (!tokens.includes(coverage.toFixed(0)) && !tokens.includes(coverage.toFixed(1))) return false
  if (!payload.dataSufficient && /数据(充足|充分)/.test(trimmed)) return false

  return true
}
