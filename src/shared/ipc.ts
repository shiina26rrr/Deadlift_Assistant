// IPC 通道契约：命名采用 `域:资源:操作` 三段式。
// 渲染进程通过 preload 暴露的受限 API 访问主进程功能，不直接接触 Node.js。
import type {
  OnlineConfig,
  AnonymousSummary,
  ModelArtifactBundle,
  PolishResult,
  VoiceAvailability,
  SampleInfo,
  SampleDownloadProgress
} from './types'

export const IPC = {
  fileReadModel: 'file:readModel',
  fileReadVideo: 'file:readVideo',
  filePickVideo: 'file:pickVideo',
  fileReadSample: 'file:readSample',
  fileListSamples: 'file:listSamples',
  sampleDownload: 'sample:download',
  sampleCancel: 'sample:cancel',
  sampleDownloadProgress: 'sample:downloadProgress',
  modelLoad: 'model:load',
  httpPostText: 'http:postText',
  voiceSpeak: 'voice:speak',
  voiceStop: 'voice:stop',
  voiceCheckAvailability: 'voice:checkAvailability',
  getResourceBaseUrl: 'app:resourceBaseUrl',
  logWrite: 'log:write',
  logRead: 'log:read',
  logGetPath: 'log:getPath',
  reportSave: 'report:save',
  reportList: 'report:list'
} as const

export interface ModelPaths {
  modelPath: string
  wasmPath: string
  error?: string
}

export interface VideoInfo {
  path: string
  url: string
  width: number
  height: number
  error?: string
}

export interface SaveReportResult {
  saved: boolean
  error?: string
}

/** preload 暴露给渲染进程的受限 API。 */
export interface ElectronAPI {
  readModel(): Promise<ModelPaths>
  readVideo(fileName: string): Promise<VideoInfo>
  pickVideo(): Promise<VideoInfo>
  readSample(file: string, location: 'builtin' | 'user'): Promise<VideoInfo>
  listSamples(): Promise<SampleInfo[]>
  /** 读取本地动作模型产物；缺失/损坏返回 null（渲染进程按"仅规则分析"处理）。 */
  loadModel(): Promise<ModelArtifactBundle | null>
  downloadSample(file: string): Promise<{ started: boolean; error?: string }>
  cancelSample(file: string): Promise<void>
  onSampleProgress(callback: (progress: SampleDownloadProgress) => void): () => void
  postText(config: OnlineConfig, payload: AnonymousSummary): Promise<PolishResult>
  speak(text: string): Promise<{ started: boolean; error?: string }>
  stopSpeak(): Promise<void>
  checkVoiceAvailability(): Promise<VoiceAvailability>
  getResourceBaseUrl(): Promise<string>
  logWrite(level: string, source: string, message: string): Promise<void>
  logRead(maxLines?: number): Promise<string>
  logGetPath(): Promise<string>
  saveReport(report: unknown): Promise<SaveReportResult>
  listReports(): Promise<unknown[]>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
