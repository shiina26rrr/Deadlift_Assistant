// 文件日志：写入 %APPDATA%/DeadliftAssistant/logs/app.log，带时间戳与级别。
// 主进程直接写文件；渲染进程通过 IPC 转发。日志轮转：单文件超过 2MB 时重命名 .old 并新建。
import { app } from 'electron'
import { join } from 'node:path'
import { appendFileSync, existsSync, renameSync, statSync, mkdirSync } from 'node:fs'

export type LogLevel = 'info' | 'warn' | 'error' | 'debug'

const MAX_FILE_SIZE = 2 * 1024 * 1024

let logDir: string
let logFile: string

function ensureLogPaths(): void {
  if (logFile) return
  logDir = join(app.getPath('userData'), 'logs')
  mkdirSync(logDir, { recursive: true })
  logFile = join(logDir, 'app.log')
}

function rotateIfNeeded(): void {
  try {
    if (existsSync(logFile) && statSync(logFile).size > MAX_FILE_SIZE) {
      const oldFile = join(logDir, 'app.log.old')
      if (existsSync(oldFile)) renameSync(oldFile, `${oldFile}.bak`)
      renameSync(logFile, oldFile)
    }
  } catch {
    // 轮转失败不影响写入
  }
}

function formatLine(level: LogLevel, source: string, message: string): string {
  const ts = new Date().toISOString()
  return `[${ts}] [${level.toUpperCase()}] [${source}] ${message}\n`
}

export function writeLog(level: LogLevel, source: string, message: string): void {
  ensureLogPaths()
  rotateIfNeeded()
  const line = formatLine(level, source, message)
  try {
    appendFileSync(logFile, line, 'utf8')
  } catch {
    // 写入失败时静默，避免日志本身导致崩溃
  }
}

export function getLogPath(): string {
  ensureLogPaths()
  return logFile
}

export function readRecentLogs(maxLines = 500): string {
  ensureLogPaths()
  try {
    if (!existsSync(logFile)) return ''
    const { readFileSync } = require('node:fs')
    const content = readFileSync(logFile, 'utf8') as string
    const lines = content.split('\n').filter(Boolean)
    return lines.slice(-maxLines).join('\n')
  } catch {
    return ''
  }
}
