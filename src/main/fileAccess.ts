// 文件访问服务：模型/WASM 资源地址、内置样本清单、本地视频选择与授权、样本下载。
// 渲染进程不直接接触文件系统，全部通过本服务经 IPC 完成。
import { app, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { IPC } from '../shared/ipc'
import type { ModelPaths, VideoInfo } from '../shared/ipc'
import type { SampleInfo, SampleDownloadProgress } from '../shared/types'
import { RESOURCE_PATHS } from '../shared/config'
import { isSafeSampleName } from '../shared/sampleManifest'
import {
  downloadSample,
  listSamples,
  resolveSamplePath,
  type SamplePaths
} from './sampleLibrary'

/** 用户已授权本地文件：id -> 绝对路径。仅在当前会话有效。 */
const authorizedLocalFiles = new Map<string, string>()

export function resolveAuthorizedLocal(id: string): string | undefined {
  return authorizedLocalFiles.get(id)
}

export interface PathContext {
  /** 是否开发模式（渲染进程由 Vite dev server 提供）。 */
  isDev: boolean
  /** Vite dev server 地址，例如 http://localhost:5173。 */
  devServerUrl?: string
  /** 渲染进程构建产物目录（打包后用于承载模型/样本）。 */
  rendererDir: string
  /** 资源根目录（开发模式下为项目 resources 目录）。 */
  resourcesDir: string
  /** 用户可写样本目录（下载补充样本）。 */
  userSamplesDir: string
}

function resourceBaseUrl(ctx: PathContext): string {
  if (ctx.isDev && ctx.devServerUrl) {
    return ctx.devServerUrl.replace(/\/$/, '')
  }
  return 'app://bundle'
}

export function registerFileAccess(ctx: PathContext): void {
  const samplePaths: SamplePaths = {
    resourcesDir: ctx.resourcesDir,
    userSamplesDir: ctx.userSamplesDir
  }

  ipcMain.handle(IPC.fileReadModel, async (): Promise<ModelPaths> => {
    const base = resourceBaseUrl(ctx)
    return {
      modelPath: `${base}/${RESOURCE_PATHS.model}`,
      wasmPath: `${base}/${RESOURCE_PATHS.wasmDir}`
    }
  })

  ipcMain.handle(IPC.getResourceBaseUrl, async (): Promise<string> => resourceBaseUrl(ctx))

  // 统一清单结构（含 samples 数组的对象）；文件缺失不标可用。
  ipcMain.handle(IPC.fileListSamples, async (): Promise<SampleInfo[]> => {
    return listSamples(samplePaths)
  })

  // 内置样本走 app://bundle；用户下载样本经授权映射为 app://local。
  ipcMain.handle(
    IPC.fileReadSample,
    async (_event, sampleFile: string, location: 'builtin' | 'user'): Promise<VideoInfo> => {
      if (!isSafeSampleName(sampleFile)) {
        return { path: '', url: '', width: 0, height: 0, error: 'FILE_NOT_FOUND' }
      }
      const loc: 'builtin' | 'user' = location === 'user' ? 'user' : 'builtin'
      const path = resolveSamplePath(samplePaths, sampleFile, loc)
      if (!path) {
        return { path: '', url: '', width: 0, height: 0, error: 'FILE_NOT_FOUND' }
      }
      if (loc === 'builtin') {
        const base = resourceBaseUrl(ctx)
        return {
          path,
          url: `${base}/${RESOURCE_PATHS.samplesDir}/${encodeURIComponent(sampleFile)}`,
          width: 0,
          height: 0
        }
      }
      const id = randomUUID()
      authorizedLocalFiles.set(id, path)
      return { path, url: `app://local/${id}`, width: 0, height: 0 }
    }
  )

  // 样本下载：同一文件同时只允许一个下载，进度经 sender 推送，可取消。
  const activeDownloads = new Map<string, AbortController>()

  ipcMain.handle(IPC.sampleDownload, async (event, file: string) => {
    if (typeof file !== 'string' || !isSafeSampleName(file)) {
      return { started: false, error: 'FILE_NAME_UNSAFE' }
    }
    if (activeDownloads.has(file)) {
      return { started: false, error: 'ALREADY_DOWNLOADING' }
    }
    const controller = new AbortController()
    activeDownloads.set(file, controller)
    const onProgress = (progress: SampleDownloadProgress): void => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC.sampleDownloadProgress, progress)
    }
    try {
      const result = await downloadSample(samplePaths, file, onProgress, controller.signal)
      if (result.ok) return { started: true }
      return { started: false, error: result.error ?? (result.cancelled ? 'CANCELLED' : 'UNKNOWN') }
    } finally {
      activeDownloads.delete(file)
    }
  })

  ipcMain.handle(IPC.sampleCancel, async (_event, file: string) => {
    if (typeof file === 'string') activeDownloads.get(file)?.abort()
  })

  // 用户导入视频：弹出选择框并授权该文件，返回可播放的 app://local/<id> 地址。
  ipcMain.handle(IPC.filePickVideo, async (): Promise<VideoInfo> => {
    const result = await dialog.showOpenDialog({
      title: '选择本地视频',
      properties: ['openFile'],
      filters: [
        { name: '视频文件', extensions: ['mp4', 'webm', 'mov', 'mkv', 'avi'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { path: '', url: '', width: 0, height: 0, error: 'FILE_NOT_FOUND' }
    }
    const filePath = result.filePaths[0]
    const id = randomUUID()
    authorizedLocalFiles.set(id, filePath)
    return {
      path: filePath,
      url: `app://local/${id}`,
      width: 0,
      height: 0
    }
  })

  // 兼容直接传入文件名读取内置样本（默认按内置资源解析）。
  ipcMain.handle(IPC.fileReadVideo, async (_event, fileName: string): Promise<VideoInfo> => {
    if (typeof fileName !== 'string' || !isSafeSampleName(fileName)) {
      return { path: '', url: '', width: 0, height: 0, error: 'FILE_NOT_FOUND' }
    }
    const path = resolveSamplePath(samplePaths, fileName, 'builtin')
    if (!path) return { path: '', url: '', width: 0, height: 0, error: 'FILE_NOT_FOUND' }
    const base = resourceBaseUrl(ctx)
    return {
      path,
      url: `${base}/${RESOURCE_PATHS.samplesDir}/${encodeURIComponent(fileName)}`,
      width: 0,
      height: 0
    }
  })
}

export function getDefaultPaths(): Omit<PathContext, 'isDev' | 'devServerUrl'> {
  const projectRoot = app.getAppPath()
  const rendererDir = join(projectRoot, 'out', 'renderer')
  return {
    rendererDir,
    // 打包后 resources 内容已由 Vite（publicDir）复制进 out/renderer，且 resources/ 本身
    // 不随包发布（仅 out/** 与 package.json 入场），因此内置资源目录须与渲染产物同目录；
    // 开发模式下直接指向项目 resources 源目录。
    resourcesDir: app.isPackaged ? rendererDir : join(projectRoot, 'resources'),
    userSamplesDir: join(app.getPath('userData'), 'samples')
  }
}
