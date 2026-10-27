// Worker 与渲染进程之间的消息协议（对应设计 worker:pose:detect）。
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'

export interface PoseInitMessage {
  type: 'INIT'
  modelAssetPath: string
  wasmPath: string
}

export interface PoseDetectMessage {
  type: 'POSE_DETECT'
  id: number
  frame: ImageBitmap
  timestamp: number
}

export interface PoseCloseMessage {
  type: 'CLOSE'
}

export type PoseInMessage = PoseInitMessage | PoseDetectMessage | PoseCloseMessage

export interface PoseResultMessage {
  type: 'POSE_RESULT'
  id: number
  landmarks: NormalizedLandmark[]
  timestamp: number
}

export interface PoseErrorMessage {
  type: 'POSE_ERROR'
  id?: number
  error: string
  message?: string
}

export interface PoseInitDoneMessage {
  type: 'INIT_DONE'
}

export interface PoseInitErrorMessage {
  type: 'INIT_ERROR'
  error: string
  message?: string
}

export type PoseOutMessage =
  | PoseResultMessage
  | PoseErrorMessage
  | PoseInitDoneMessage
  | PoseInitErrorMessage
