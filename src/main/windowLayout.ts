// 初始窗口布局计算：按主显示器工作区约束尺寸并居中，不依赖 Electron，便于单测。
export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

export interface SizePreference {
  width: number
  height: number
}

export interface WindowLayout {
  width: number
  height: number
  minWidth: number
  minHeight: number
  x: number
  y: number
}

const DEFAULT_MARGIN = 16

export function computeWindowLayout(
  workArea: WorkArea,
  preferred: SizePreference,
  minimum: SizePreference,
  margin: number = DEFAULT_MARGIN
): WindowLayout {
  const areaWidth = Math.max(1, Math.floor(workArea.width))
  const areaHeight = Math.max(1, Math.floor(workArea.height))
  const availableWidth = Math.max(320, areaWidth - margin)
  const availableHeight = Math.max(240, areaHeight - margin)

  const minWidth = Math.min(minimum.width, availableWidth)
  const minHeight = Math.min(minimum.height, availableHeight)

  const width = Math.min(preferred.width, Math.max(minWidth, Math.floor(availableWidth * 0.92)))
  const height = Math.min(preferred.height, Math.max(minHeight, Math.floor(availableHeight * 0.92)))

  return {
    width,
    height,
    minWidth,
    minHeight,
    x: workArea.x + Math.round((areaWidth - width) / 2),
    y: workArea.y + Math.round((areaHeight - height) / 2)
  }
}
