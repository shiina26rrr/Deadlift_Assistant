// 本地动作模型产物读取（主进程）：从随包只读资源加载并校验，供渲染进程经 IPC 获取。
// 产物缺失/损坏时返回 null，渲染进程按"无模型、仅规则分析"处理，不静默降级为假预测。
import { ipcMain } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { IPC } from '../shared/ipc'
import { RESOURCE_PATHS } from '../shared/config'
import { sanitizeModelArtifact } from '../shared/modelArtifact'
import type { ModelArtifactBundle } from '../shared/types'
import { writeLog } from './logger'

export interface ModelStorePaths {
  /** 随包只读资源目录（与渲染产物同源）。 */
  resourcesDir: string
}

/** 读取并校验动作模型产物；缺失/损坏返回 null。 */
export function loadModelArtifact(resourcesDir: string): ModelArtifactBundle | null {
  try {
    const path = join(resourcesDir, RESOURCE_PATHS.actionModel)
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    const bundle = sanitizeModelArtifact(parsed)
    if (!bundle) writeLog('warn', 'model', '动作模型产物结构非法，忽略（按仅规则分析处理）')
    return bundle
  } catch (error) {
    writeLog('warn', 'model', `动作模型产物读取失败: ${(error as Error)?.message ?? '未知'}`)
    return null
  }
}

/** 注册模型产物读取 IPC。 */
export function registerModelStore(paths: ModelStorePaths): void {
  ipcMain.handle(IPC.modelLoad, async (): Promise<ModelArtifactBundle | null> =>
    loadModelArtifact(paths.resourcesDir)
  )
}
