// 骨架渲染：在覆盖于视频之上的画布绘制关键点与连线。
// 使用归一化坐标按"视频在容器内的实际显示矩形"缩放，因此画布的缩放、留白与镜像
// 不会改变测量结果（测量使用原始像素坐标）。
import type { FramingState, NormalizedLandmark, Side } from '@shared/types'

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const CONNECTIONS: Record<Side, Array<[number, number]>> = {
  left: [
    [11, 13],
    [13, 15],
    [11, 23],
    [23, 25],
    [25, 27]
  ],
  right: [
    [12, 14],
    [14, 16],
    [12, 24],
    [24, 26],
    [26, 28]
  ]
}

const JOINT_INDEX: Record<Side, number[]> = {
  left: [11, 13, 15, 23, 25, 27],
  right: [12, 14, 16, 24, 26, 28]
}

function fitRect(videoW: number, videoH: number, boxW: number, boxH: number): Rect {
  if (videoW <= 0 || videoH <= 0 || boxW <= 0 || boxH <= 0) {
    return { x: 0, y: 0, w: boxW, h: boxH }
  }
  const scale = Math.min(boxW / videoW, boxH / videoH)
  const w = videoW * scale
  const h = videoH * scale
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h }
}

export class CanvasRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private container: HTMLElement

  constructor(canvas: HTMLCanvasElement, container: HTMLElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建 2D 画布上下文')
    this.ctx = ctx
    this.container = container
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1
    const rect = this.container.getBoundingClientRect()
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr))
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr))
    this.canvas.style.width = `${rect.width}px`
    this.canvas.style.height = `${rect.height}px`
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  clear(): void {
    const rect = this.container.getBoundingClientRect()
    this.ctx.clearRect(0, 0, rect.width, rect.height)
  }

  render(
    landmarks: NormalizedLandmark[],
    videoSize: { width: number; height: number },
    side: Side | null,
    dataValid: boolean,
    framing?: FramingState | null
  ): void {
    const rect = this.container.getBoundingClientRect()
    this.ctx.clearRect(0, 0, rect.width, rect.height)
    // 引导框在无人时也显示，且不参与测量坐标（仅显示层）。
    if (framing) this.drawFramingGuide(framing, videoSize)
    if (!side || landmarks.length === 0) return

    const box = fitRect(videoSize.width, videoSize.height, rect.width, rect.height)
    const toXY = (i: number): { x: number; y: number; visibility: number } => {
      const p = landmarks[i]
      return {
        x: box.x + (p?.x ?? 0) * box.w,
        y: box.y + (p?.y ?? 0) * box.h,
        visibility: p?.visibility ?? 0
      }
    }

    this.ctx.lineWidth = 3
    this.ctx.strokeStyle = dataValid ? '#6F8F7B' : '#B0AFA8'
    for (const [a, b] of CONNECTIONS[side]) {
      const pa = toXY(a)
      const pb = toXY(b)
      // 连线两端点均需有效，不绘制跨越遮挡区间的连线。
      if (pa.visibility < 0.2 || pb.visibility < 0.2) continue
      this.ctx.beginPath()
      this.ctx.moveTo(pa.x, pa.y)
      this.ctx.lineTo(pb.x, pb.y)
      this.ctx.stroke()
    }

    for (const index of JOINT_INDEX[side]) {
      const p = toXY(index)
      if (p.visibility < 0.2) continue
      this.ctx.beginPath()
      this.ctx.arc(p.x, p.y, 4, 0, Math.PI * 2)
      this.ctx.fillStyle = dataValid ? '#4C6B57' : '#9A9890'
      this.ctx.fill()
    }
  }

  /** 绘制竖向人体引导框：仅显示层，坐标不随框变化（推理仍用完整原始画面）。 */
  private drawFramingGuide(framing: FramingState, videoSize: { width: number; height: number }): void {
    const rect = this.container.getBoundingClientRect()
    const view = fitRect(videoSize.width, videoSize.height, rect.width, rect.height)
    const g = framing.box
    const x = view.x + g.x * view.w
    const y = view.y + g.y * view.h
    const w = g.width * view.w
    const h = g.height * view.h

    const ready = framing.ready
    const uncertain = framing.status === 'UNCERTAIN' || framing.status === 'UNDETECTED'
    this.ctx.save()
    this.ctx.lineWidth = ready ? 3 : 2
    this.ctx.setLineDash(ready ? [] : [9, 6])
    this.ctx.strokeStyle = ready ? '#6F8F7B' : uncertain ? '#B0AFA8' : '#C08A5A'
    this.ctx.strokeRect(x, y, w, h)
    this.ctx.restore()
  }
}
