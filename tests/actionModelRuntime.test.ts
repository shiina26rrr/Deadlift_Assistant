import { describe, expect, it } from 'vitest'
import {
  FEATURE_ORDER,
  extractFeatures,
  isModelCompatible,
  predict,
  runInference,
  runInferenceBatch
} from '@renderer/analysis/actionModelRuntime'
import type {
  BodyProportionReference,
  ModelArtifactBundle,
  SegmentedAction
} from '@shared/types'
import { angleEntry, makeAngleSet } from './helpers'

const DIM = FEATURE_ORDER.length

function zeros(): number[] {
  return Array.from({ length: DIM }, () => 0)
}

function action(overrides: Partial<SegmentedAction> = {}): SegmentedAction {
  return {
    index: 1,
    side: 'right',
    startMs: 0,
    endMs: 1000,
    frames: [makeAngleSet({ armGroundAngle: angleEntry(100), elbowInnerAngle: angleEntry(170) })],
    displacement: { shoulder: 0.1, hip: 0.2 },
    validRatio: 0.8,
    ...overrides
  }
}

/** 类别 i 仅在特征 i 上有权重；用于构造可预期的软极大值。 */
function model(overrides: Partial<ModelArtifactBundle> = {}): ModelArtifactBundle {
  const classes = ['GB', 'PB', 'LLK']
  const W = Array.from({ length: classes.length * DIM }, () => 0)
  W[0 * DIM + 0] = 1
  W[1 * DIM + 1] = 1
  W[2 * DIM + 2] = 1
  return {
    modelVersion: 'm1',
    featureSpec: {
      version: 'feat-1',
      order: [...FEATURE_ORDER],
      units: {},
      missingMaskRule: 'NaN 表示缺失',
      window: { actionStatsMs: 1000, normalizationRef: 'per-feature' }
    },
    normalization: { mean: zeros(), std: Array.from({ length: DIM }, () => 1) },
    classes,
    rejectThreshold: 0.5,
    checksum: 'sha256:abc',
    validationStatus: 'VALIDATED',
    params: { W, b: [0, 0, 0] },
    ...overrides
  }
}

const proportion: BodyProportionReference = {
  side: 'right',
  frozenAt: 0,
  estimate: {
    featureVersion: 'prop-1',
    ratios: { thighToShin: 1.1, trunkToLeg: 0.66, armToTrunk: 0.9 },
    validFrames: 20,
    dispersion: 0.01,
    quality: 'OK'
  }
}

describe('extractFeatures', () => {
  it('按 spec.order 输出固定维度向量，含时序统计与节奏/有效性', () => {
    const spec = model().featureSpec
    const feats = extractFeatures(action(), null, spec)
    expect(feats).not.toBeNull()
    expect(feats!.length).toBe(DIM)
    const at = (name: string): number => feats![spec.order.indexOf(name)]
    expect(at('armGroundAngle_mean')).toBeCloseTo(100)
    expect(at('elbowInnerAngle_mean')).toBeCloseTo(170)
    expect(at('durationSec')).toBeCloseTo(1)
    expect(at('validRatio')).toBeCloseTo(0.8)
    expect(at('displacementShoulder')).toBeCloseTo(0.1)
    // 无比例参考 → 比例特征为缺失（NaN）
    expect(Number.isNaN(at('proportionThighToShin'))).toBe(true)
  })

  it('提供身体比例参考时写入对应比例', () => {
    const spec = model().featureSpec
    const feats = extractFeatures(action(), proportion, spec)!
    expect(feats[spec.order.indexOf('proportionThighToShin')]).toBeCloseTo(1.1)
    expect(feats[spec.order.indexOf('proportionArmToTrunk')]).toBeCloseTo(0.9)
  })

  it('比例参考质量为 LOW 时按缺失处理，不写入近似值', () => {
    const spec = model().featureSpec
    const low: BodyProportionReference = {
      ...proportion,
      estimate: { ...proportion.estimate, quality: 'LOW' }
    }
    const feats = extractFeatures(action(), low, spec)!
    expect(Number.isNaN(feats[spec.order.indexOf('proportionThighToShin')])).toBe(true)
    expect(Number.isNaN(feats[spec.order.indexOf('proportionTrunkToLeg')])).toBe(true)
    expect(Number.isNaN(feats[spec.order.indexOf('proportionArmToTrunk')])).toBe(true)
  })

  it('无帧或空规范返回 null', () => {
    expect(extractFeatures(action({ frames: [] }), null, model().featureSpec)).toBeNull()
    const emptySpec = { ...model().featureSpec, order: [] }
    expect(extractFeatures(action(), null, emptySpec)).toBeNull()
  })

  it('未知特征名列以缺失表示', () => {
    const spec = { ...model().featureSpec, order: ['unknown_feature'] }
    const feats = extractFeatures(action(), null, spec)!
    expect(Number.isNaN(feats[0])).toBe(true)
  })
})

describe('predict 推理与拒判', () => {
  it('置信度足够时输出预测类别与概率', () => {
    const feats = zeros()
    feats[0] = 10
    const result = predict(feats, model())
    expect(result.available).toBe(true)
    expect(result.rejected).toBe(false)
    expect(result.predictedClass).toBe('GB')
    expect(result.probabilities?.GB).toBeGreaterThan(0.9)
  })

  it('类间概率接近时按阈值拒判为 LOW_CONFIDENCE', () => {
    const result = predict(zeros(), model())
    expect(result.rejected).toBe(true)
    expect(result.reason).toBe('LOW_CONFIDENCE')
  })

  it('特征为 null 或缺太多时拒判为 FEATURE_MISSING', () => {
    expect(predict(null, model()).reason).toBe('FEATURE_MISSING')
    const feats = zeros()
    for (let i = 0; i < 12; i += 1) feats[i] = NaN
    expect(predict(feats, model()).reason).toBe('FEATURE_MISSING')
  })

  it('维度或参数不符时拒判为 MODEL_INCOMPATIBLE', () => {
    expect(predict([0, 0], model()).reason).toBe('MODEL_INCOMPATIBLE')
    const broken = model({ params: { W: [1, 0], b: [0] } })
    expect(predict(zeros(), broken).reason).toBe('MODEL_INCOMPATIBLE')
  })
})

describe('isModelCompatible / runInference', () => {
  it('形状自检识别不兼容模型', () => {
    expect(isModelCompatible(model())).toBe(true)
    expect(isModelCompatible(model({ params: { W: [] } }))).toBe(false)
    expect(isModelCompatible(model({ normalization: { mean: [0], std: [1] } }))).toBe(false)
  })

  it('组合入口在验证失败时拒绝预测（按仅规则分析）', () => {
    const result = runInference(action(), null, model({ validationStatus: 'FAILED' }))
    expect(result.rejected).toBe(true)
    expect(result.reason).toBe('MODEL_INCOMPATIBLE')
  })

  it('组合入口正常推理并返回可用摘要', () => {
    const result = runInference(action(), proportion, model())
    expect(result.modelVersion).toBe('m1')
    expect(result.rejected).toBe(true) // 零特征 → 低把握拒判（保守，不假称结论）
    expect(result.reason).toBe('LOW_CONFIDENCE')
  })
})

/** 让 GB/PB/LLK 分别只对 位移肩/位移髋/时长 敏感，便于构造可预期的可用/拒判动作。 */
function biasedModel(overrides: Partial<ModelArtifactBundle> = {}): ModelArtifactBundle {
  const classes = ['GB', 'PB', 'LLK']
  const index = (name: string): number => FEATURE_ORDER.indexOf(name as (typeof FEATURE_ORDER)[number])
  const W = Array.from({ length: classes.length * DIM }, () => 0)
  W[0 * DIM + index('displacementShoulder')] = 1
  W[1 * DIM + index('displacementHip')] = 1
  W[2 * DIM + index('durationSec')] = 1
  return { ...model({ params: { W, b: [0, 0, 0] } }), ...overrides }
}

/** 使位移/时长为高值的可用动作（GB），或全零的拒判动作。 */
function decisiveAction(): SegmentedAction {
  return action({ displacement: { shoulder: 6, hip: 0 }, startMs: 0, endMs: 1000 })
}
function rejectedAction(): SegmentedAction {
  return action({ displacement: { shoulder: 0, hip: 0 }, startMs: 0, endMs: 0 })
}

describe('runInferenceBatch 整组推理聚合', () => {
  it('无完成动作 → DATA_INSUFFICIENT', () => {
    const result = runInferenceBatch([], proportion, biasedModel())
    expect(result.rejected).toBe(true)
    expect(result.reason).toBe('DATA_INSUFFICIENT')
  })

  it('模型验证失败 → MODEL_INCOMPATIBLE', () => {
    const result = runInferenceBatch([decisiveAction()], proportion, biasedModel({ validationStatus: 'FAILED' }))
    expect(result.rejected).toBe(true)
    expect(result.reason).toBe('MODEL_INCOMPATIBLE')
  })

  it('各次均拒判 → 取主要拒判原因', () => {
    const result = runInferenceBatch([rejectedAction(), rejectedAction()], proportion, biasedModel())
    expect(result.rejected).toBe(true)
    expect(result.reason).toBe('LOW_CONFIDENCE')
  })

  it('可用与拒判混合 → 仅对可用结果聚合，输出预测类别', () => {
    const result = runInferenceBatch([decisiveAction(), rejectedAction()], proportion, biasedModel())
    expect(result.rejected).toBe(false)
    expect(result.predictedClass).toBe('GB')
    expect(result.probabilities?.GB).toBeGreaterThan(0.9)
  })

  it('组内模式不一致 → MIXED_PATTERN，并附类别分布', () => {
    const llkAction = action({ displacement: { shoulder: 0, hip: 0 }, startMs: 0, endMs: 6000 })
    const result = runInferenceBatch(
      [decisiveAction(), decisiveAction(), llkAction, llkAction],
      proportion,
      biasedModel()
    )
    expect(result.rejected).toBe(true)
    expect(result.reason).toBe('MIXED_PATTERN')
    expect(result.classDistribution?.GB).toBeCloseTo(0.5)
    expect(result.classDistribution?.LLK).toBeCloseTo(0.5)
    expect(result.probabilities?.GB).toBeCloseTo(0.5)
  })

  it('各动作支持不同类别且平均概率低于阈值 → LOW_CONFIDENCE（不因平均而放行）', () => {
    const pbAction = action({ displacement: { shoulder: 0, hip: 6 }, startMs: 0, endMs: 0 })
    const llkAction = action({ displacement: { shoulder: 0, hip: 0 }, startMs: 0, endMs: 6000 })
    const result = runInferenceBatch([decisiveAction(), pbAction, llkAction], proportion, biasedModel())
    expect(result.rejected).toBe(true)
    expect(result.reason).toBe('LOW_CONFIDENCE')
    expect(result.classDistribution?.GB).toBeCloseTo(1 / 3)
    expect(result.classDistribution?.PB).toBeCloseTo(1 / 3)
    expect(result.classDistribution?.LLK).toBeCloseTo(1 / 3)
  })

  it('一致且达阈值 → 接受并给出类别分布', () => {
    const result = runInferenceBatch(
      [decisiveAction(), decisiveAction(), decisiveAction(), rejectedAction()],
      proportion,
      biasedModel()
    )
    expect(result.rejected).toBe(false)
    expect(result.predictedClass).toBe('GB')
    expect(result.classDistribution?.GB).toBeCloseTo(1)
    expect(result.classDistribution?.PB).toBeCloseTo(0)
  })
})
