// MediaPipe Pose Landmarker 封装（使用 Tasks Vision Web 接口，不混用不同代 API）。
// 仅负责提取 33 个关键点及置信度；角度、阶段、评价均由自研代码完成。
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'

export interface PoseExtractorOptions {
  modelAssetPath: string
  wasmPath: string
  /** 首选推理代理；GPU 失败时自动回退 CPU。 */
  delegate?: 'GPU' | 'CPU'
}

export interface PoseExtractor {
  /** 同步检测一帧；返回 33 个关键点（未检出时为空数组）。 */
  detect(frame: ImageBitmap, timestampMs: number): NormalizedLandmark[]
  close(): void
}

async function createLandmarker(
  vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
  options: PoseExtractorOptions,
  delegate: 'GPU' | 'CPU'
): Promise<PoseLandmarker> {
  return PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: options.modelAssetPath, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5
  })
}

export async function createPoseExtractor(options: PoseExtractorOptions): Promise<PoseExtractor> {
  const vision = await FilesetResolver.forVisionTasks(options.wasmPath)
  let landmarker: PoseLandmarker
  const preferred = options.delegate ?? 'GPU'
  try {
    landmarker = await createLandmarker(vision, options, preferred)
  } catch {
    // GPU 不可用时回退 CPU，保证普通电脑可用。
    landmarker = await createLandmarker(vision, options, 'CPU')
  }

  let lastTimestamp = -1

  return {
    detect(frame: ImageBitmap, timestampMs: number): NormalizedLandmark[] {
      // MediaPipe 要求时间戳单调递增；输入切换等场景可能回退，这里强制保证单调性。
      const safeTs = timestampMs > lastTimestamp ? timestampMs : lastTimestamp + 1
      lastTimestamp = safeTs
      const result = landmarker.detectForVideo(frame, safeTs)
      const first = result.landmarks && result.landmarks[0]
      return first ? first : []
    },
    close(): void {
      try {
        landmarker.close()
      } catch {
        // 忽略重复关闭错误。
      }
    }
  }
}
