// 在线文本润色适配器：默认关闭；每组结束至多请求一次；只发送匿名整组摘要。
// 先展示内置总结，再异步获取润色文本；失败时保留内置反馈。
import type {
  AnonymousSummary,
  GroupReport,
  OnlineConfig,
  PolishResult
} from '@shared/types'
import { NEUTRAL_ADVICE_ID } from './advicePolicy'

/**
 * 构建只含必要匿名数值的摘要，不含录像、截图、关键点、文件路径或个人信息。
 * 只发送通过建议门槛筛选后的建议，不发送未入选候选问题，避免把本地已拒绝的观察润色出来。
 */
export function buildAnonymousSummary(report: GroupReport): AnonymousSummary {
  return {
    completedCount: report.completedCount,
    durationSec: report.durationSec,
    validCoveragePercent: report.validCoveragePercent,
    dataSufficient: report.dataSufficient,
    angleRanges: report.angleRanges,
    suggestions: report.suggestions
  }
}

export async function polish(report: GroupReport, config: OnlineConfig): Promise<PolishResult> {
  if (!config.enabled) return { success: false, error: 'DISABLED' }
  if (!config.baseUrl || !config.modelName) return { success: false, error: 'FORMAT_ERROR' }
  const summary = buildAnonymousSummary(report)
  try {
    return await window.electronAPI.postText(config, summary)
  } catch {
    return { success: false, error: 'NETWORK_ERROR' }
  }
}

/**
 * 组后语音播报的简短中文总结（不逐次播报）。
 * 与报告共用同一事实源：只播报筛选后的建议，不直接读未过门槛的候选问题。
 */
export function buildVoiceSummary(report: GroupReport): string {
  const parts = [`本组完成 ${report.completedCount} 次`]
  if (!report.dataSufficient) {
    parts.push('有效数据不足，暂不给出评价')
    return parts.join('，')
  }
  const primary = report.suggestions.find((s) => !s.relatedIssues.includes(NEUTRAL_ADVICE_ID))
  if (primary) parts.push(`主要观察：${primary.text}`)
  else parts.push('未检测到明显观察项')
  return parts.join('，')
}
