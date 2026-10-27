// 应用状态存储：集中配置（阈值可持久化）、语音与在线开关、运行状态。
// API Key 绝不持久化，仅会话内保存在内存中。
import { cloneDefaultConfig, DEFAULT_CONFIG } from '@shared/config'
import type { AppConfig } from '@shared/types'

const STORAGE_KEY = 'deadlift-assistant-config-v1'

export type PoseBackend = 'worker' | 'inline' | 'none'

function mergeSection<T extends object>(base: T, partial: Partial<T> | undefined): T {
  return partial ? { ...base, ...partial } : base
}

export class StateStore {
  config: AppConfig
  voiceEnabled = false
  poseBackend: PoseBackend = 'none'

  constructor() {
    this.config = this.load()
  }

  private load(): AppConfig {
    const base = cloneDefaultConfig()
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return base
      const saved = JSON.parse(raw) as Partial<AppConfig>
      return {
        filter: mergeSection(base.filter, saved.filter),
        phase: mergeSection(base.phase, saved.phase),
        rule: mergeSection(base.rule, saved.rule),
        side: mergeSection(base.side, saved.side),
        calibration: mergeSection(base.calibration, saved.calibration),
        framing: mergeSection(base.framing, saved.framing),
        proportion: mergeSection(base.proportion, saved.proportion),
        advice: mergeSection(base.advice, saved.advice),
        // 在线配置仅恢复非敏感字段；API Key 不持久化。
        online: {
          ...base.online,
          enabled: saved.online?.enabled ?? base.online.enabled,
          baseUrl: saved.online?.baseUrl ?? base.online.baseUrl,
          modelName: saved.online?.modelName ?? base.online.modelName,
          timeoutMs: saved.online?.timeoutMs ?? base.online.timeoutMs,
          apiKey: ''
        },
        report: mergeSection(base.report, saved.report)
      }
    } catch {
      return base
    }
  }

  /** 持久化非敏感配置（不含 API Key）。 */
  persist(): void {
    try {
      const toSave: AppConfig = {
        ...this.config,
        online: { ...this.config.online, apiKey: '' }
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave))
    } catch {
      // 忽略存储失败（隐私模式等）。
    }
  }

  resetToDefaults(): void {
    // 保留会话内的 API Key 与启用状态之外，其余恢复默认。
    const apiKey = this.config.online.apiKey
    this.config = cloneDefaultConfig()
    this.config.online.apiKey = apiKey
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // 忽略。
    }
  }
}

export const DEFAULT_APP_CONFIG = DEFAULT_CONFIG
