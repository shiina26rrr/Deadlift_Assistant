// 在线文本润色：在主进程发起 HTTP 请求，避免渲染进程 CORS 限制，
// 并确保 API Key 不进入渲染进程日志或快照。
// 协议：默认采用常见 Chat Completions 兼容 HTTP 接口（可配置 Base URL / 模型 / Key）。
import { ipcMain } from 'electron'
import { IPC } from '../shared/ipc'
import type { OnlineConfig, AnonymousSummary, PolishResult } from '../shared/types'
import { POLISH_SYSTEM_PROMPT, buildUserPrompt, checkConsistency } from './polishGuard'

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>
}

function mapError(error: unknown): string {
  const err = error as Error
  if (err && err.name === 'AbortError') return 'TIMEOUT'
  return 'NETWORK_ERROR'
}

export function registerHttpClient(): void {
  ipcMain.handle(
    IPC.httpPostText,
    async (_event, config: OnlineConfig, payload: AnonymousSummary): Promise<PolishResult> => {
      if (!config || !config.enabled) return { success: false, error: 'DISABLED' }
      if (!config.baseUrl || !config.modelName) return { success: false, error: 'FORMAT_ERROR' }

      const controller = new AbortController()
      const timeoutMs = Math.max(1000, config.timeoutMs || 15000)
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // API Key 仅用于本次请求头，不写入日志、快照或源码。
            Authorization: `Bearer ${config.apiKey}`
          },
          body: JSON.stringify({
            model: config.modelName,
            messages: [
              { role: 'system', content: POLISH_SYSTEM_PROMPT },
              { role: 'user', content: buildUserPrompt(payload) }
            ],
            temperature: 0.3,
            max_tokens: 300
          }),
          signal: controller.signal
        })

        if (response.status === 401 || response.status === 403) {
          return { success: false, error: 'AUTH_FAILED' }
        }
        if (response.status === 429) {
          return { success: false, error: 'RATE_LIMITED' }
        }
        if (!response.ok) {
          return { success: false, error: 'NETWORK_ERROR' }
        }

        let json: ChatCompletionResponse
        try {
          json = (await response.json()) as ChatCompletionResponse
        } catch {
          return { success: false, error: 'FORMAT_ERROR' }
        }
        const text = json?.choices?.[0]?.message?.content?.trim()
        if (!text) return { success: false, error: 'FORMAT_ERROR' }
        if (!checkConsistency(text, payload)) return { success: false, error: 'FORMAT_ERROR' }
        return { success: true, polishedText: text }
      } catch (error) {
        return { success: false, error: mapError(error) }
      } finally {
        clearTimeout(timer)
      }
    }
  )
}
