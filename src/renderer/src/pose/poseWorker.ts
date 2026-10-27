// MediaPipe 推理 Worker：逐帧接收 ImageBitmap，返回关键点。
// 使用经典 Worker（iife），因为 MediaPipe tasks-vision 依赖 importScripts 加载 WASM 胶水层。
import { createPoseExtractor, type PoseExtractor } from './poseExtractor'
import type { PoseInMessage } from './poseMessages'

const ctx = globalThis as unknown as DedicatedWorkerGlobalScope

let extractor: PoseExtractor | null = null

ctx.onmessage = async (event: MessageEvent<PoseInMessage>): Promise<void> => {
  const msg = event.data

  if (msg.type === 'INIT') {
    try {
      extractor = await createPoseExtractor({
        modelAssetPath: msg.modelAssetPath,
        wasmPath: msg.wasmPath
      })
      ctx.postMessage({ type: 'INIT_DONE' })
    } catch (error) {
      extractor = null
      ctx.postMessage({
        type: 'INIT_ERROR',
        error: 'MODEL_NOT_LOADED',
        message: (error as Error)?.message ?? String(error)
      })
    }
    return
  }

  if (msg.type === 'CLOSE') {
    extractor?.close()
    extractor = null
    return
  }

  if (msg.type === 'POSE_DETECT') {
    if (!extractor) {
      msg.frame.close()
      ctx.postMessage({ type: 'POSE_ERROR', id: msg.id, error: 'MODEL_NOT_LOADED' })
      return
    }
    try {
      const landmarks = extractor.detect(msg.frame, msg.timestamp)
      ctx.postMessage({ type: 'POSE_RESULT', id: msg.id, landmarks, timestamp: msg.timestamp })
    } catch (error) {
      ctx.postMessage({
        type: 'POSE_ERROR',
        id: msg.id,
        error: 'UNKNOWN',
        message: (error as Error)?.message ?? String(error)
      })
    } finally {
      msg.frame.close()
    }
  }
}

export {}
