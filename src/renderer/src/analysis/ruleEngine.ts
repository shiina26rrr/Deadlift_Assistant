// 启发式规则引擎：有技术原则来源、阈值待验证。
// 不输出动作标准分、医学结论或统一"合格角度"；不把数据集标签当作通用判错规则。
import type { CandidateIssue, Phase, RuleConfig, ValidationStatus } from '@shared/types'
import type { FrameFeatures } from './types'

export interface RuleFrameResult {
  ruleId: string
  active: boolean
}

interface RuleMeta {
  stage: Phase
  dependentMetrics: string[]
  source: string
  validationStatus: ValidationStatus
  feedbackText: string
}

/** 规则元数据：适用阶段、依赖指标、技术原则来源、验证状态与反馈文案。 */
export const RULE_META: Record<string, RuleMeta> = {
  'elbow-bend': {
    stage: 'PULLING',
    dependentMetrics: ['elbowInnerAngle'],
    source: 'ACE 硬拉指导（技术原则）；阈值为待验证的启发式参数',
    validationStatus: 'PENDING',
    feedbackText: '起拉阶段出现持续明显弯肘，可检查起始手臂是否保持相对伸直（依据肘内角，不以手臂倾角替代）。'
  },
  'arm-deviation': {
    stage: 'PULLING',
    dependentMetrics: ['armGroundAngle'],
    source: '欧洲力量举联合会传统硬拉技术资料（技术原则）；阈值为待验证的启发式参数',
    validationStatus: 'PENDING',
    feedbackText: '起拉阶段手臂方向明显偏离垂直，作为辅助观察；不据此断言杠铃轨迹错误。'
  },
  'shoulder-hip-async': {
    stage: 'PULLING',
    dependentMetrics: ['shoulderNorm', 'hipNorm'],
    source: '实验性候选观察（尚未充分验证）',
    validationStatus: 'EXPERIMENTAL',
    feedbackText: '起拉阶段肩髋上升可能不协调；这是实验性观察，默认不启用。'
  }
}

/** 单帧规则判定（纯函数，便于受控序列测试）。 */
export function evaluateFrame(
  features: FrameFeatures,
  phase: Phase,
  config: RuleConfig,
  reference?: { shoulderY: number; hipY: number }
): RuleFrameResult[] {
  const inPull = phase === 'PULLING'
  const elbow = features.angles.elbowInnerAngle
  const arm = features.angles.armGroundAngle

  const results: RuleFrameResult[] = [
    {
      ruleId: 'elbow-bend',
      active: inPull && elbow.validity === 'VALID' && elbow.value < config.elbowBendThreshold
    },
    {
      ruleId: 'arm-deviation',
      active: inPull && arm.validity === 'VALID' && Math.abs(arm.value - 90) > config.armDeviationThreshold
    }
  ]

  let asyncActive = false
  if (config.enableShoulderHipCheck && inPull && reference && features.valid) {
    const shoulderDelta = features.shoulderNorm.y - reference.shoulderY
    const hipDelta = features.hipNorm.y - reference.hipY
    asyncActive = Math.abs(shoulderDelta - hipDelta) > config.shoulderHipAsyncThreshold
  }
  results.push({ ruleId: 'shoulder-hip-async', active: asyncActive })
  return results
}

function minDurationFor(ruleId: string, config: RuleConfig): number {
  if (ruleId === 'elbow-bend') return config.elbowBendMinDurationMs
  if (ruleId === 'arm-deviation') return config.armDeviationMinDurationMs
  return 0
}

function paramsFor(ruleId: string, config: RuleConfig): Record<string, number> {
  if (ruleId === 'elbow-bend') return { elbowBendThreshold: config.elbowBendThreshold }
  if (ruleId === 'arm-deviation') return { armDeviationThreshold: config.armDeviationThreshold }
  return { shoulderHipAsyncThreshold: config.shoulderHipAsyncThreshold }
}

/** 跨帧累计触发时长，输出候选问题。 */
export class RuleEngine {
  private durations = new Map<string, number>()
  private reference: { shoulderY: number; hipY: number } | null = null
  private lastTimestamp = 0
  private hasLast = false
  private wasPulling = false

  reset(): void {
    this.durations.clear()
    this.reference = null
    this.lastTimestamp = 0
    this.hasLast = false
    this.wasPulling = false
  }

  update(features: FrameFeatures, phase: Phase, config: RuleConfig): void {
    if (phase === 'PULLING' && !this.wasPulling) {
      this.reference = { shoulderY: features.shoulderNorm.y, hipY: features.hipNorm.y }
    }
    this.wasPulling = phase === 'PULLING'

    const dt = this.hasLast ? Math.min(1000, Math.max(0, features.timestamp - this.lastTimestamp)) : 0
    this.hasLast = true
    this.lastTimestamp = features.timestamp

    if (!features.valid) return

    for (const result of evaluateFrame(features, phase, config, this.reference ?? undefined)) {
      if (result.active) {
        this.durations.set(result.ruleId, (this.durations.get(result.ruleId) ?? 0) + dt)
      }
    }
  }

  getIssues(config: RuleConfig): CandidateIssue[] {
    const issues: CandidateIssue[] = []
    for (const [ruleId, duration] of this.durations) {
      const meta = RULE_META[ruleId]
      if (!meta) continue
      if (duration < minDurationFor(ruleId, config)) continue
      issues.push({
        ruleId,
        stage: meta.stage,
        dependentMetrics: meta.dependentMetrics,
        params: paramsFor(ruleId, config),
        duration,
        source: meta.source,
        validationStatus: meta.validationStatus,
        feedbackText: meta.feedbackText
      })
    }
    return issues.sort((a, b) => b.duration - a.duration)
  }
}
