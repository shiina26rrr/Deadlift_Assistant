// 输入管理：本地视频导入、摄像头开启/关闭、播放事件与输入切换重置。
import type { AppErrorCode } from '@shared/types'

export type InputMode = 'none' | 'video' | 'camera'

export interface InputEvents {
  /** 用户暂停或播放器暂停（自然结束除外）：清时间线连续性，不结算/不清组。 */
  onPause: () => void
  /** 恢复播放：清时间线连续性后继续分析。 */
  onResume: () => void
  /** 用户跳转：清时间线连续性，不结算/不清组。 */
  onSeeking: () => void
  /** 视频正常播放结束：只在此结算一次。 */
  onEnded: () => void
  /** 输入就绪（尺寸已知）。 */
  onReady: (info: { width: number; height: number; mode: InputMode }) => void
  /** 错误提示（中文）。 */
  onError: (code: AppErrorCode, message: string) => void
}

const ERROR_MESSAGES: Record<string, string> = {
  PERMISSION_DENIED: '摄像头权限被拒绝，请在系统设置中允许访问摄像头后重试。',
  DEVICE_BUSY: '摄像头被其他程序占用，请关闭占用程序后重试。',
  DEVICE_NOT_FOUND: '未找到可用的摄像头设备，请检查连接。',
  UNSUPPORTED_FORMAT: '该视频格式不受支持，请选择 MP4 / WebM 等格式。',
  FILE_NOT_FOUND: '未能读取所选视频文件。',
  UNKNOWN: '输入设备打开失败，请重试或改用其他设备。'
}

function mapCameraError(error: unknown): AppErrorCode {
  const name = (error as Error)?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'PERMISSION_DENIED'
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'DEVICE_BUSY'
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return 'DEVICE_NOT_FOUND'
  }
  return 'UNKNOWN'
}

export class InputManager {
  private video: HTMLVideoElement
  private events: InputEvents
  private stream: MediaStream | null = null
  private mode: InputMode = 'none'
  /** 输入代次：每次换源/关闭递增，丢弃旧输入迟到的异步回包。 */
  private generation = 0

  constructor(video: HTMLVideoElement, events: InputEvents) {
    this.video = video
    this.events = events
    this.attachPlaybackEvents()
  }

  get currentMode(): InputMode {
    return this.mode
  }

  private attachPlaybackEvents(): void {
    // 自然结束时浏览器也可能先发 pause；此时不按“用户暂停”处理，保证 ended 能结算。
    this.video.addEventListener('pause', () => {
      if (!this.video.ended) this.events.onPause()
    })
    this.video.addEventListener('play', () => this.events.onResume())
    this.video.addEventListener('seeking', () => this.events.onSeeking())
    this.video.addEventListener('ended', () => this.events.onEnded())
  }

  private async waitForMetadata(): Promise<void> {
    if (this.video.readyState >= 1 && this.video.videoWidth > 0) return
    await new Promise<void>((resolve, reject) => {
      const onLoaded = (): void => {
        cleanup()
        resolve()
      }
      const onError = (): void => {
        cleanup()
        reject(new Error('UNSUPPORTED_FORMAT'))
      }
      const cleanup = (): void => {
        this.video.removeEventListener('loadedmetadata', onLoaded)
        this.video.removeEventListener('error', onError)
      }
      this.video.addEventListener('loadedmetadata', onLoaded)
      this.video.addEventListener('error', onError)
    })
  }

  private stopTracks(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop()
      this.stream = null
    }
    if (this.video.srcObject) {
      this.video.srcObject = null
    }
  }

  /** 换源前立即让旧输入失效：停流并递增代次。 */
  private invalidateInput(): number {
    this.generation += 1
    this.stopTracks()
    return this.generation
  }

  /** 加载本地视频（通过 app:// 或 dev server 地址）。 */
  async loadVideo(url: string): Promise<void> {
    const gen = this.invalidateInput()
    this.mode = 'video'
    this.video.loop = false
    this.video.srcObject = null
    this.video.src = url
    this.video.load()
    try {
      await this.waitForMetadata()
    } catch {
      if (gen !== this.generation) return
      this.events.onError('UNSUPPORTED_FORMAT', ERROR_MESSAGES.UNSUPPORTED_FORMAT)
      return
    }
    if (gen !== this.generation) return
    this.events.onReady({
      width: this.video.videoWidth,
      height: this.video.videoHeight,
      mode: 'video'
    })
  }

  async listCameras(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return []
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((d) => d.kind === 'videoinput')
  }

  async openCamera(deviceId?: string): Promise<void> {
    const gen = this.invalidateInput()
    if (!navigator.mediaDevices?.getUserMedia) {
      this.events.onError('DEVICE_NOT_FOUND', '当前环境不支持摄像头访问。')
      return
    }
    try {
      const constraints: MediaStreamConstraints = {
        audio: false,
        video: deviceId ? { deviceId: { exact: deviceId } } : true
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      // 打开期间已切换/关闭输入：立即停止新流，不能覆盖当前输入。
      if (gen !== this.generation) {
        for (const track of stream.getTracks()) track.stop()
        return
      }
      this.stream = stream
      this.mode = 'camera'
      this.video.loop = false
      this.video.src = ''
      this.video.srcObject = stream
      await this.video.play().catch(() => undefined)
      await this.waitForMetadata()
      if (gen !== this.generation) return
      this.events.onReady({
        width: this.video.videoWidth,
        height: this.video.videoHeight,
        mode: 'camera'
      })
    } catch (error) {
      if (gen !== this.generation) return
      this.closeCamera()
      const code = mapCameraError(error)
      this.events.onError(code, ERROR_MESSAGES[code] ?? ERROR_MESSAGES.UNKNOWN)
    }
  }

  closeCamera(): void {
    this.invalidateInput()
    this.mode = 'none'
  }

  /** 释放一切输入（切换到无输入状态）。 */
  stopAll(): void {
    this.invalidateInput()
    this.video.pause()
    this.video.removeAttribute('src')
    this.video.load()
    this.mode = 'none'
  }
}
