// Electron 主进程入口：窗口生命周期、安全基线、IPC 注册与自定义协议安装。
import { app, BrowserWindow, shell, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import { computeWindowLayout } from './windowLayout'
import { registerAppScheme, handleAppProtocol } from './protocol'
import { registerFileAccess, resolveAuthorizedLocal, getDefaultPaths } from './fileAccess'
import { registerHttpClient } from './httpClient'
import { registerVoiceBridge } from './voiceBridge'
import { registerModelStore } from './modelStore'
import { writeLog, readRecentLogs, getLogPath } from './logger'
import type { LogLevel } from './logger'
import { saveReport, listReports, getLibraryPath } from './reportStorage'
import { IPC } from '../shared/ipc'

const isDev = !app.isPackaged
const devServerUrl = process.env['ELECTRON_RENDERER_URL']

// 必须在 app ready 之前注册特权协议。
registerAppScheme()

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const workArea = screen.getPrimaryDisplay().workArea
  const layout = computeWindowLayout(
    workArea,
    { width: 1600, height: 900 },
    { width: 1024, height: 680 }
  )

  mainWindow = new BrowserWindow({
    ...layout,
    show: false,
    backgroundColor: '#F5F4EF',
    title: '硬拉辅助检测',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 安全基线：隔离上下文、关闭 nodeIntegration、保持 webSecurity 开启。
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      sandbox: false,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // 外部链接一律用系统浏览器打开，不在应用内导航。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && devServerUrl) {
    void mainWindow.loadURL(devServerUrl)
  } else {
    // 打包后通过 app:// 同源加载，保证模型 / WASM / Worker 路径可用。
    void mainWindow.loadURL('app://bundle/index.html')
  }
}

app.whenReady().then(() => {
  const paths = getDefaultPaths()
  handleAppProtocol(paths.rendererDir, resolveAuthorizedLocal)
  registerFileAccess({ isDev, devServerUrl, ...paths })
  registerHttpClient()
  registerVoiceBridge()
  registerModelStore({ resourcesDir: paths.resourcesDir })

  ipcMain.handle(IPC.logWrite, (_e, level: string, source: string, message: string) => {
    writeLog(level as LogLevel, source, message)
  })
  ipcMain.handle(IPC.logRead, (_e, maxLines?: number) => readRecentLogs(maxLines))
  ipcMain.handle(IPC.logGetPath, () => getLogPath())

  ipcMain.handle(IPC.reportSave, (_e, report: unknown) => saveReport(report))
  ipcMain.handle(IPC.reportList, () => listReports())
  writeLog('info', 'main', `本地报告库路径: ${getLibraryPath()}`)

  writeLog('info', 'main', `应用启动 (dev=${isDev})`)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
