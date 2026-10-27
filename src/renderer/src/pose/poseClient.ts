// 渲染进程侧姿态客户端：优先在 Worker 中推理以保证 UI 流畅；
// 若 Worker 不可用则回退到主线程内联推理，保证功能可用（并如实标记后端）。
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { createPoseExtractor, type PoseExtractor } from './poseExtractor'
import type { PoseInMessage, PoseOutMessage } from './poseMessages'

export type PoseBackend = 'worker' | 'inline' | 'none'

export interface PoseClientStatus {
  backend: PoseBackend
  error?: string
}

export class PoseClient {
  private worker: Worker | null = null
  private inline: PoseExtractor | null = null
  private backend: PoseBackend = 'none'
  private inflight = false
  private nextId = 1
  private pending: ((result: NormalizedLandmark[] | null) => void) | null = null
  private pendingTimer: number | null = null
  private initResolve: ((ok: boolean) => void) | null = null
  private initErrorMessage: string | undefined

  get status(): PoseBackend {
    return this.backend
  }

  get lastError(): string | undefined {
    return this.initErrorMessage
  }

  private handleWorkerMessage(event: MessageEvent<PoseOutMessage>): void {
    const msg = event.data
    if (msg.type === 'INIT_DONE') {
      this.initResolve?.(true)
      this.initResolve = null
      return
    }
    if (msg.type === 'INIT_ERROR') {
      this.initErrorMessage = msg.message
      this.initResolve?.(false)
      this.initResolve = null
      return
    }
    if (msg.type === 'POSE_RESULT') {
      this.settle(msg.landmarks)
      return
    }
    if (msg.type === 'POSE_ERROR') {
      this.settle(null)
    }
  }

  /** 结清在途检测：无论成功、失败还是超时，都必须解除 inflight 并返回结果。 */
  private settle(result: NormalizedLandmark[] | null): void {
    if (this.pendingTimer !== null) {
      window.clearTimeout(this.pendingTimer)
      this.pendingTimer = null
    }
    this.inflight = false
    const resolve = this.pending
    this.pending = null
    resolve?.(result)
  }

  /** Worker 运行期错误/超时：结清在途检测并停用后端，避免 poseBusy 永久卡住。 */
  private failWorker(reason: string): void {
    this.initErrorMessage = reason
    this.settle(null)
    this.worker?.terminate()
    this.worker = null
    this.backend = 'none'
  }

  private initWorker(worker: Worker, modelAssetPath: string, wasmPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const timeout = window.setTimeout(() => {
        if (!settled) {
          settled = true
          this.initResolve = null
          resolve(false)
        }
      }, 60000)
      this.initResolve = (ok: boolean): void => {
        if (settled) return
        settled = true
        window.clearTimeout(timeout)
        resolve(ok)
      }
      worker.onmessage = (event: MessageEvent<PoseOutMessage>) => this.handleWorkerMessage(event)
      worker.onerror = (event: ErrorEvent) => {
        if (this.worker === worker) {
          this.failWorker(event.message || '姿态 Worker 运行异常')
          return
        }
        this.initErrorMessage = event.message
        this.initResolve?.(false)
        this.initResolve = null
      }
      worker.postMessage({ type: 'INIT', modelAssetPath, wasmPath } satisfies PoseInMessage)
    })
  }

  /** 初始化推理后端；模型加载失败时返回 backend='none'。 */
  async init(modelAssetPath: string, wasmPath: string): Promise<PoseClientStatus> {
    try {
      const worker = new Worker(new URL('./poseWorker.ts', import.meta.url))
      const ok = await this.initWorker(worker, modelAssetPath, wasmPath)
      if (ok) {
        this.worker = worker
        this.backend = 'worker'
        return { backend: 'worker' }
      }
      worker.terminate()
    } catch (error) {
      this.initErrorMessage = (error as Error)?.message ?? String(error)
    }

    try {
      this.inline = await createPoseExtractor({ modelAssetPath, wasmPath })
      this.backend = 'inline'
      return { backend: 'inline' }
    } catch (error) {
      this.initErrorMessage = (error as Error)?.message ?? String(error)
      this.backend = 'none'
      return { backend: 'none', error: this.initErrorMessage }
    }
  }

  /**
   * 检测一帧。若已有在途推理则丢弃该帧并立即返回 null（实时模式跳过过时帧）。
   * 调用方负责传入 ImageBitmap；本方法总是接管其生命周期。
   */
  detect(frame: ImageBitmap, timestamp: number): Promise<NormalizedLandmark[] | null> {
    if (this.backend === 'none' || this.inflight) {
      frame.close()
      return Promise.resolve(null)
    }

    if (this.backend === 'inline') {
      if (!this.inline) {
        frame.close()
        return Promise.resolve(null)
      }
      this.inflight = true
      return Promise.resolve().then(() => {
        try {
          return this.inline ? this.inline.detect(frame, timestamp) : null
        } catch {
          return null
        } finally {
          this.inflight = false
          frame.close()
        }
      })
    }

    this.inflight = true
    return new Promise((resolve) => {
      this.pending = resolve
      this.pendingTimer = window.setTimeout(() => {
        this.pendingTimer = null
        this.failWorker('姿态推理超时（Worker 未返回）')
      }, 6000)
      const message: PoseInMessage = { type: 'POSE_DETECT', id: this.nextId, frame, timestamp }
      this.nextId += 1
      this.worker?.postMessage(message, [frame])
    })
  }

  close(): void {
    this.settle(null)
    if (this.worker) {
      this.worker.postMessage({ type: 'CLOSE' } satisfies PoseInMessage)
      this.worker.terminate()
      this.worker = null
    }
    this.inline?.close()
    this.inline = null
    this.inflight = false
    this.pending = null
    this.backend = 'none'
  }
}
