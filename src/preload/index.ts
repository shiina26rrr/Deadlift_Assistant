// Preload：通过 contextBridge 暴露受限 IPC API。
// 渲染进程不直接接触 Node.js 或文件系统，仅能调用这里声明的方法。
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { ElectronAPI } from '../shared/ipc'
import type { AnonymousSummary, OnlineConfig, SampleDownloadProgress } from '../shared/types'

const api: ElectronAPI = {
  readModel: () => ipcRenderer.invoke(IPC.fileReadModel),
  readVideo: (fileName: string) => ipcRenderer.invoke(IPC.fileReadVideo, fileName),
  pickVideo: () => ipcRenderer.invoke(IPC.filePickVideo),
  readSample: (file: string, location: 'builtin' | 'user') =>
    ipcRenderer.invoke(IPC.fileReadSample, file, location),
  listSamples: () => ipcRenderer.invoke(IPC.fileListSamples),
  loadModel: () => ipcRenderer.invoke(IPC.modelLoad),
  downloadSample: (file: string) => ipcRenderer.invoke(IPC.sampleDownload, file),
  cancelSample: (file: string) => ipcRenderer.invoke(IPC.sampleCancel, file),
  onSampleProgress: (callback: (progress: SampleDownloadProgress) => void) => {
    const listener = (_event: unknown, progress: SampleDownloadProgress): void => callback(progress)
    ipcRenderer.on(IPC.sampleDownloadProgress, listener)
    return () => ipcRenderer.removeListener(IPC.sampleDownloadProgress, listener)
  },
  postText: (config: OnlineConfig, payload: AnonymousSummary) =>
    ipcRenderer.invoke(IPC.httpPostText, config, payload),
  speak: (text: string) => ipcRenderer.invoke(IPC.voiceSpeak, text),
  stopSpeak: () => ipcRenderer.invoke(IPC.voiceStop),
  checkVoiceAvailability: () => ipcRenderer.invoke(IPC.voiceCheckAvailability),
  getResourceBaseUrl: () => ipcRenderer.invoke(IPC.getResourceBaseUrl),
  logWrite: (level: string, source: string, message: string) =>
    ipcRenderer.invoke(IPC.logWrite, level, source, message),
  logRead: (maxLines?: number) => ipcRenderer.invoke(IPC.logRead, maxLines),
  logGetPath: () => ipcRenderer.invoke(IPC.logGetPath),
  saveReport: (report: unknown) => ipcRenderer.invoke(IPC.reportSave, report),
  listReports: () => ipcRenderer.invoke(IPC.reportList)
}

contextBridge.exposeInMainWorld('electronAPI', api)
