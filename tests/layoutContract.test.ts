import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const html = readFileSync(join(root, 'src/renderer/index.html'), 'utf8')
const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')
const app = readFileSync(join(root, 'src/renderer/src/ui/app.ts'), 'utf8')

describe('R19 样本库界面移除契约', () => {
  it('HTML 不包含样本库模块与入口', () => {
    for (const token of ['samples-panel', 'samples-list', 'samples-source', 'samples-license', '演示样本库']) {
      expect(html).not.toContain(token)
    }
  })

  it('样式表不保留样本库样式', () => {
    expect(css).not.toContain('.samples-')
    expect(css).not.toMatch(/\.sample-item|\.sample-tag|\.sample-progress/)
  })

  it('渲染层不再加载或渲染样本库', () => {
    expect(app).not.toContain('listSamples(')
    expect(app).not.toContain('onSampleProgress(')
    expect(app).not.toContain('samples-list')
  })
})

describe('R20 布局自适应契约', () => {
  it('包含宽度与高度断点', () => {
    expect(css).toContain('max-width: 1439px')
    expect(css).toContain('max-width: 1151px')
    expect(css).toContain('max-height: 720px')
    expect(css).toContain('max-height: 640px')
  })

  it('主区域使用可收缩的 Grid 轨道，不保留固定最小宽度/高度', () => {
    expect(css).toMatch(/\.main-area\s*\{[^}]*display:\s*grid/s)
    expect(css).toContain('minmax(0, 7fr)')
    expect(css).toContain('minmax(0, 1fr)')
    expect(css).not.toMatch(/min-width:\s*240px/)
    expect(css).not.toMatch(/min-height:\s*320px/)
  })

  it('禁止整页等比缩放', () => {
    expect(css).not.toMatch(/transform:\s*scale\(/)
    expect(css).not.toMatch(/(^|\s)zoom:/)
  })

  it('重绘入口携带最近一次入框状态并监听 DPR', () => {
    expect(app).toContain('scheduleOverlayRedraw')
    expect(app).toContain('lastFraming')
    expect(app).toContain('watchDpr')
  })
})
