import { describe, expect, it } from 'vitest'
import { sanitizeModelArtifact } from '@shared/modelArtifact'
import type { ModelArtifactBundle } from '@shared/types'

function baseline(overrides: Partial<ModelArtifactBundle> = {}): ModelArtifactBundle {
  return {
    modelVersion: 'm1',
    featureSpec: {
      version: 'feat-1',
      order: ['a', 'b'],
      units: { a: 'deg', b: 'ratio' },
      missingMaskRule: 'NaN 表示缺失',
      window: { actionStatsMs: 1000, normalizationRef: 'per-feature' }
    },
    normalization: { mean: [0, 0], std: [1, 1] },
    classes: ['GB', 'PB'],
    rejectThreshold: 0.5,
    checksum: 'sha256:abc',
    validationStatus: 'VALIDATED',
    params: { W: [1, 0, 0, 1], b: [0, 0] },
    ...overrides
  }
}

describe('sanitizeModelArtifact', () => {
  it('接受合法产物并保留字段', () => {
    const result = sanitizeModelArtifact(baseline())
    expect(result).not.toBeNull()
    expect(result?.modelVersion).toBe('m1')
    expect(result?.featureSpec.order).toEqual(['a', 'b'])
    expect(result?.classes).toEqual(['GB', 'PB'])
  })

  it('拒绝非对象/缺字段', () => {
    expect(sanitizeModelArtifact(null)).toBeNull()
    expect(sanitizeModelArtifact('x')).toBeNull()
    expect(sanitizeModelArtifact(baseline({ modelVersion: '' }))).toBeNull()
  })

  it('拒绝维度不一致的标准化参数与权重', () => {
    expect(sanitizeModelArtifact(baseline({ normalization: { mean: [0], std: [1] } }))).toBeNull()
    expect(sanitizeModelArtifact(baseline({ params: { W: [1, 0] } }))).toBeNull()
    expect(sanitizeModelArtifact(baseline({ params: { W: [1, 0, 0, 1], b: [0] } }))).toBeNull()
  })

  it('拒绝空类别、非法阈值与非法验证状态', () => {
    expect(sanitizeModelArtifact(baseline({ classes: [] }))).toBeNull()
    expect(sanitizeModelArtifact(baseline({ rejectThreshold: 1.5 }))).toBeNull()
    expect(
      sanitizeModelArtifact(
        baseline({ validationStatus: 'BOGUS' as unknown as ModelArtifactBundle['validationStatus'] })
      )
    ).toBeNull()
  })

  it('校验通过后返回深拷贝，不改动入参', () => {
    const input = baseline()
    const result = sanitizeModelArtifact(input)
    result!.featureSpec.order.push('c')
    expect(input.featureSpec.order).toEqual(['a', 'b'])
  })
})
