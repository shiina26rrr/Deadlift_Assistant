// 训练端/运行端预测一致性（T11）：加载开发阶段导出的模型产物，
// 对固定输入重建运行时预测，与 Python 训练端计算结果比对（tests/fixtures/model-consistency.json）。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sanitizeModelArtifact } from '@shared/modelArtifact'
import { FEATURE_ORDER, isModelCompatible, predict } from '@renderer/analysis/actionModelRuntime'

const root = process.cwd()
const modelRaw = JSON.parse(readFileSync(resolve(root, 'resources/models/action-model.json'), 'utf-8'))
const fixture = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/model-consistency.json'), 'utf-8'))

const model = sanitizeModelArtifact(modelRaw)

interface Case {
  id: string
  features: (number | null)[]
  expected: {
    rejected: boolean
    reason?: string
    predictedClass?: string
    probabilities?: Record<string, number>
  }
}

describe('训练端/运行端预测一致性', () => {
  it('导出的模型产物通过 sanitize 校验且与运行时特征顺序一致', () => {
    expect(model).not.toBeNull()
    const order = model!.featureSpec.order
    // 选型可只使用特征子集（如不含比例），但顺序必须与运行时 FEATURE_ORDER 一致。
    expect(order.length).toBeGreaterThan(0)
    expect(order).toEqual(FEATURE_ORDER.filter((name) => order.includes(name)))
    expect(isModelCompatible(model!)).toBe(true)
  })

  it('固定输入的运行端预测与训练端一致', () => {
    expect(model).not.toBeNull()
    for (const c of fixture.cases as Case[]) {
      const got = predict(c.features as unknown as number[], model!)
      expect(got.rejected, c.id).toBe(c.expected.rejected)
      if (c.expected.reason) expect(got.reason, c.id).toBe(c.expected.reason)
      if (c.expected.predictedClass) expect(got.predictedClass, c.id).toBe(c.expected.predictedClass)
      if (c.expected.probabilities && got.probabilities) {
        for (const k of Object.keys(c.expected.probabilities)) {
          expect(got.probabilities[k], `${c.id}:${k}`).toBeCloseTo(c.expected.probabilities[k], 6)
        }
      }
    }
  })
})
