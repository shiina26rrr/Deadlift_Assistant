// 本地报告库：以 JSON 结构化文件存储（等价结构化本地存储，减少依赖）。
// 保存到用户可写目录（%APPDATA%/DeadliftAssistant/reports.json），不写 EXE/只读资源目录。
// 以组 ID 幂等写入：同 ID 覆盖更新，语音重播/AI 更新/报告重开不新增重复组。
// 库中只存报告摘要：不存录像、完整关键点序列、API Key 或其他秘密。
import { app } from 'electron'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import type { ReportLibrary, StoredReport } from '../shared/types'
import {
  emptyLibrary,
  mergeReport,
  parseLibrary,
  sanitizeReport
} from '../shared/reportLibrary'

let libraryFile: string
/** 串行队列：读-改-写整体排队，避免并发保存互相覆盖或产生半写文件。 */
let saveChain: Promise<void> = Promise.resolve()

function ensureLibraryPath(): string {
  if (!libraryFile) {
    const dir = join(app.getPath('userData'))
    mkdirSync(dir, { recursive: true })
    libraryFile = join(dir, 'reports.json')
  }
  return libraryFile
}

/**
 * 读取本地库。
 * - 文件不存在（旧版无库）→ 空库，不报错、不清空。
 * - 读取失败（权限/IO）→ 抛出明确错误，调用方不得继续覆盖原文件。
 * - 内容损坏 → 备份为带时间戳的 `.corrupt-*`；备份失败同样抛出，避免静默丢弃。
 */
function readLibrary(): ReportLibrary {
  const file = ensureLibraryPath()
  if (!existsSync(file)) return emptyLibrary()

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`读取本地记录失败：${(error as Error)?.message ?? 'IO_ERROR'}`)
  }

  const parsed = parseLibrary(raw)
  if (parsed) return parsed

  const backup = `${file}.corrupt-${Date.now()}`
  try {
    renameSync(file, backup)
  } catch (error) {
    throw new Error(`本地记录损坏且备份失败：${(error as Error)?.message ?? 'IO_ERROR'}`)
  }
  return emptyLibrary()
}

/** 同目录临时文件写完整后原子替换；失败时删除临时文件并保留原文件。 */
function writeLibrary(lib: ReportLibrary): void {
  const file = ensureLibraryPath()
  const tmp = join(dirname(file), `reports.json.tmp-${process.pid}`)
  writeFileSync(tmp, JSON.stringify(lib, null, 2), 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // 临时文件清理失败不掩盖原始写入错误。
    }
    throw new Error(`写入本地记录失败：${(error as Error)?.message ?? 'IO_ERROR'}`)
  }
}

/** 幂等保存：同 setId 覆盖更新；整体串行，失败明确返回原因。 */
export function saveReport(input: unknown): Promise<{ saved: boolean; error?: string }> {
  const report = sanitizeReport(input)
  if (!report) {
    return Promise.resolve({ saved: false, error: 'FORMAT_ERROR' })
  }

  const task = saveChain
    .then(() => {
      const lib = readLibrary()
      writeLibrary(mergeReport(lib, report))
      return { saved: true }
    })
    .catch((error: unknown) => ({
      saved: false,
      error: (error as Error)?.message ?? 'UNKNOWN'
    }))

  saveChain = task.then(
    () => undefined,
    () => undefined
  )
  return task
}

/** 列出记录；读取/损坏保护失败时向上抛出，由界面明确提示（不当作空历史）。 */
export function listReports(): StoredReport[] {
  return readLibrary().reports
}

export function getLibraryPath(): string {
  return ensureLibraryPath()
}
