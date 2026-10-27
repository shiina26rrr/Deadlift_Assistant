// 样本库（主进程）：读取内置清单、合并用户下载目录、解析可用性并提供下载。
// 内置样本为只读资源（resources/samples），下载样本写入用户可写目录（userData/samples）。
// 下载成功并校验后标记可用；断网不损坏已有文件；重复下载会被跳过。
import { join } from 'node:path'
import {
  existsSync,
  readFileSync,
  mkdirSync,
  createWriteStream,
  statSync,
  unlinkSync,
  renameSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { SampleDownloadProgress, SampleInfo, SampleManifestEntry } from '../shared/types'
import { isSafeSampleName, parseManifest } from '../shared/sampleManifest'

export interface SamplePaths {
  /** 与渲染构建产物同源的资源目录（开发模式为项目 resources）。 */
  resourcesDir: string
  /** 用户可写样本目录（userData/samples）。 */
  userSamplesDir: string
}

function builtinManifestPath(p: SamplePaths): string {
  return join(p.resourcesDir, 'samples', 'manifest.json')
}

function builtinFilePath(p: SamplePaths, file: string): string {
  return join(p.resourcesDir, 'samples', file)
}

function userFilePath(p: SamplePaths, file: string): string {
  return join(p.userSamplesDir, file)
}

function fileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

/** 读取内置清单条目（含随包与可下载两类）。 */
export function loadManifestEntries(p: SamplePaths): SampleManifestEntry[] {
  try {
    if (!existsSync(builtinManifestPath(p))) return []
    return parseManifest(readFileSync(builtinManifestPath(p), 'utf8'))
  } catch {
    return []
  }
}

/**
 * 列出样本及可用性：优先用户下载目录，其次内置资源；均缺失则不标可用。
 * location 表示可用文件的实际来源；不可用时按 bundled 推断预期位置以指导下载。
 */
export function listSamples(p: SamplePaths): SampleInfo[] {
  return loadManifestEntries(p)
    .filter((e) => isSafeSampleName(e.file))
    .map((entry) => {
      const inUser = fileExists(userFilePath(p, entry.file))
      const inBuiltin = !inUser && fileExists(builtinFilePath(p, entry.file))
      const available = inUser || inBuiltin
      const location: SampleInfo['location'] = inUser
        ? 'user'
        : inBuiltin
          ? 'builtin'
          : entry.bundled
            ? 'builtin'
            : 'user'
      return { ...entry, available, location }
    })
}

/** 解析可读样本的绝对路径；文件不存在返回 undefined。 */
export function resolveSamplePath(
  p: SamplePaths,
  file: string,
  location: 'builtin' | 'user'
): string | undefined {
  if (!isSafeSampleName(file)) return undefined
  const path = location === 'user' ? userFilePath(p, file) : builtinFilePath(p, file)
  return fileExists(path) ? path : undefined
}

function findEntry(p: SamplePaths, file: string): SampleManifestEntry | undefined {
  return loadManifestEntries(p).find((e) => e.file === file)
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 下载一个可补充样本到用户目录并做完整性校验。
 * - 已存在且校验通过：直接报告完成，不重复下载。
 * - signal 触发取消：删除半成品，返回 cancelled。
 * - 校验失败：删除半成品，返回 error（不把半文件当有效视频）。
 */
export async function downloadSample(
  p: SamplePaths,
  file: string,
  onProgress: (progress: SampleDownloadProgress) => void,
  signal: AbortSignal
): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> {
  if (!isSafeSampleName(file)) return { ok: false, error: 'FILE_NAME_UNSAFE' }
  const entry = findEntry(p, file)
  if (!entry || !entry.downloadUrl) return { ok: false, error: 'NO_DOWNLOAD_SOURCE' }

  const target = userFilePath(p, file)
  const temp = `${target}.part`

  // 重复下载保护：已存在且大小/摘要一致直接完成。
  if (fileExists(target)) {
    const sizeOk = entry.size === undefined || statSync(target).size === entry.size
    const hashOk = !entry.sha256 || sha256File(target) === entry.sha256
    if (sizeOk && hashOk) {
      onProgress({ file, state: 'done', received: entry.size ?? 0, total: entry.size ?? 0 })
      return { ok: true }
    }
    // 已有文件损坏：移除后重下，不保留坏文件。
    try {
      unlinkSync(target)
    } catch {
      /* 忽略 */
    }
  }

  mkdirSync(p.userSamplesDir, { recursive: true })
  onProgress({ file, state: 'downloading', received: 0, total: entry.size ?? 0 })

  try {
    const response = await fetch(entry.downloadUrl, { signal })
    if (!response.ok || !response.body) {
      return { ok: false, error: `HTTP_${response.status}` }
    }
    const total = entry.size ?? Number(response.headers.get('content-length') ?? 0)
    let received = 0
    const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
    source.on('data', (chunk: Buffer) => {
      received += chunk.length
      onProgress({ file, state: 'downloading', received, total })
    })
    await pipeline(source, createWriteStream(temp))

    onProgress({ file, state: 'verifying', received, total })
    const sizeOk = entry.size === undefined || statSync(temp).size === entry.size
    const hashOk = !entry.sha256 || sha256File(temp) === entry.sha256
    if (!sizeOk || !hashOk) {
      try {
        unlinkSync(temp)
      } catch {
        /* 忽略 */
      }
      onProgress({ file, state: 'error', received, total, error: 'INTEGRITY_MISMATCH' })
      return { ok: false, error: 'INTEGRITY_MISMATCH' }
    }

    renameSync(temp, target)
    onProgress({ file, state: 'done', received, total })
    return { ok: true }
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp)
    } catch {
      /* 忽略 */
    }
    if (signal.aborted || (error as Error)?.name === 'AbortError') {
      onProgress({ file, state: 'cancelled', received: 0, total: entry.size ?? 0 })
      return { ok: false, cancelled: true }
    }
    const message = (error as Error)?.message ?? 'DOWNLOAD_FAILED'
    onProgress({ file, state: 'error', received: 0, total: entry.size ?? 0, error: message })
    return { ok: false, error: message }
  }
}
