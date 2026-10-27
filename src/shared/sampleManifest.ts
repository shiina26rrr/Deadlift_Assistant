// 样本清单的解析与结构约定（纯逻辑，无 Node/Electron 依赖，便于测试与两端复用）。
// 统一结构为：{ description?, source?, license?, datasetUrl?, samples: SampleManifestEntry[] }。
// 历史发行包中曾出现顶层数组写法，此处兼容读取，避免“只放入视频仍读不到库”。
import type { SampleManifestEntry } from './types'

export interface SampleManifest {
  description?: string
  source?: string
  license?: string
  datasetUrl?: string
  samples: SampleManifestEntry[]
}

function isEntry(value: unknown): value is SampleManifestEntry {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.file === 'string' && v.file.length > 0
}

/**
 * 解析清单文本，兼容“含 samples 数组的对象”与历史“顶层数组”两种写法。
 * 结构非法或 JSON 解析失败时返回空数组（由调用方按无样本处理），不抛异常。
 */
export function parseManifest(raw: string): SampleManifestEntry[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as SampleManifest).samples)
        ? (parsed as SampleManifest).samples
        : []
    return list.filter(isEntry)
  } catch {
    return []
  }
}

/** 样本文件名安全校验：禁止路径穿越，仅允许纯文件名。 */
export function isSafeSampleName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    name !== '.' &&
    name !== '..'
  )
}
