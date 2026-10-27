// 渲染进程日志：转发到主进程写入文件，不在界面展示。
// 日志文件路径：%APPDATA%/DeadliftAssistant/logs/app.log
type LogLevel = 'info' | 'warn' | 'error' | 'debug'

export function log(level: LogLevel, source: string, message: string): void {
  void window.electronAPI.logWrite(level, source, message)
}

export const logger = {
  info: (source: string, message: string): void => log('info', source, message),
  warn: (source: string, message: string): void => log('warn', source, message),
  error: (source: string, message: string): void => log('error', source, message),
  debug: (source: string, message: string): void => log('debug', source, message)
}
