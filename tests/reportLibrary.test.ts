import { describe, expect, it } from 'vitest'
import {
  emptyLibrary,
  mergeReport,
  parseLibrary,
  sanitizeReport
} from '@shared/reportLibrary'
import type { ReportVersionSnapshot, StoredReport } from '@shared/types'

function snapshot(overrides: Partial<ReportVersionSnapshot> = {}): ReportVersionSnapshot {
  return {
    calibrationVersion: 'cal-1',
    ruleVersion: 'rule-2',
    modelVersion: 'm1',
    modelPrediction: {
      available: true,
      modelVersion: 'm1',
      predictedClass: 'PB',
      rejected: false
    },
    proportionEstimate: {
      featureVersion: 'prop-1',
      ratios: { thighToShin: 1.1, trunkToLeg: 1.4, armToTrunk: 0.9 },
      validFrames: 20,
      dispersion: 0.05,
      quality: 'OK'
    },
    proportionQuality: 'OK',
    proportionFeatureVersion: 'prop-1',
    advicePolicyVersion: 'advice-1',
    adviceIds: ['elbow-bend'],
    adviceEvidence: { 'elbow-bend': '累计 0.4s' },
    ...overrides
  }
}

function report(overrides: Partial<StoredReport> = {}): StoredReport {
  return {
    setId: 's1-set-1',
    sessionId: 's1',
    completedAt: 1_700_000_000_000,
    mode: 'plan',
    setIndex: 1,
    targetReps: 5,
    source: 'camera',
    completedCount: 5,
    durationSec: 30,
    validCoveragePercent: 90,
    perMetricCoveragePercent: { armGround: 90, elbowInner: 80, kneeInner: 70, trunkLean: 60 },
    angleRanges: {
      armGround: { min: 80, max: 90, valid: true },
      elbowInner: { min: 150, max: 175, valid: true },
      kneeInner: { min: 160, max: 178, valid: true },
      trunkLean: { min: 0, max: 30, valid: true }
    },
    calibrationVersion: 'cal-1',
    ruleVersion: 'rule-1',
    dataSufficient: true,
    suggestions: ['膝盖不要内扣'],
    ...overrides
  }
}

describe('sanitizeReport', () => {
  it('接受完整记录并保留必要字段', () => {
    const result = sanitizeReport(report({ polishedText: '润色文本' }))
    expect(result).not.toBeNull()
    expect(result?.setId).toBe('s1-set-1')
    expect(result?.polishedText).toBe('润色文本')
    expect(result?.perMetricCoveragePercent.trunkLean).toBe(60)
    expect(result?.angleRanges.trunkLean.valid).toBe(true)
    expect(result?.calibrationVersion).toBe('cal-1')
    expect(result?.ruleVersion).toBe('rule-1')
  })

  it('旧记录缺快照字段时补默认值（迁移，不丢记录）', () => {
    const legacy = report()
    delete (legacy as Partial<StoredReport>).perMetricCoveragePercent
    delete (legacy as Partial<StoredReport>).angleRanges
    delete (legacy as Partial<StoredReport>).calibrationVersion
    delete (legacy as Partial<StoredReport>).ruleVersion
    const result = sanitizeReport(legacy)
    expect(result).not.toBeNull()
    expect(result?.perMetricCoveragePercent).toEqual({
      armGround: 0,
      elbowInner: 0,
      kneeInner: 0,
      trunkLean: 0
    })
    expect(result?.angleRanges.armGround.valid).toBe(false)
    expect(result?.calibrationVersion).toBe('unknown')
    expect(result?.ruleVersion).toBe('unknown')
  })

  it('拒绝缺少 setId 或非法模式的记录', () => {
    expect(sanitizeReport({ ...report(), setId: '' })).toBeNull()
    expect(sanitizeReport({ ...report(), mode: 'course' })).toBeNull()
    expect(sanitizeReport({ ...report(), source: 'cloud' })).toBeNull()
  })

  it('过滤非字符串建议，自由模式允许 targetReps 为 null', () => {
    const result = sanitizeReport(
      report({ mode: 'free', targetReps: null, suggestions: ['ok', 1, null] as unknown as string[] })
    )
    expect(result?.targetReps).toBeNull()
    expect(result?.suggestions).toEqual(['ok'])
  })

  it('拒绝非对象输入', () => {
    expect(sanitizeReport(null)).toBeNull()
    expect(sanitizeReport('x')).toBeNull()
  })

  it('保留 v3 版本快照与可见性警告', () => {
    const result = sanitizeReport(
      report({ versionSnapshot: snapshot(), framingWarnings: ['脚踝出画'] })
    )
    expect(result?.versionSnapshot?.advicePolicyVersion).toBe('advice-1')
    expect(result?.versionSnapshot?.adviceIds).toEqual(['elbow-bend'])
    expect(result?.versionSnapshot?.proportionQuality).toBe('OK')
    expect(result?.framingWarnings).toEqual(['脚踝出画'])
  })

  it('旧记录缺 v3 字段时保持 undefined，不静默重算历史', () => {
    const result = sanitizeReport(report())
    expect(result?.versionSnapshot).toBeUndefined()
    expect(result?.framingWarnings).toBeUndefined()
  })

  it('版本快照部分字段缺失时按默认补齐（版本 unknown / 质量 MISSING）', () => {
    const partial = { adviceIds: ['elbow-bend', 2] } as unknown as ReportVersionSnapshot
    const result = sanitizeReport(report({ versionSnapshot: partial }))
    expect(result?.versionSnapshot?.calibrationVersion).toBe('unknown')
    expect(result?.versionSnapshot?.modelVersion).toBe('unknown')
    expect(result?.versionSnapshot?.modelPrediction).toBeNull()
    expect(result?.versionSnapshot?.proportionQuality).toBe('MISSING')
    expect(result?.versionSnapshot?.adviceIds).toEqual(['elbow-bend'])
    expect(result?.versionSnapshot?.adviceEvidence).toEqual({})
  })

  it('过滤非字符串可见性警告；空数组视为未提供', () => {
    const filtered = sanitizeReport(
      report({ framingWarnings: ['脚踝出画', 1, ''] as unknown as string[] })
    )
    expect(filtered?.framingWarnings).toEqual(['脚踝出画'])
    expect(sanitizeReport(report({ framingWarnings: [] }))?.framingWarnings).toBeUndefined()
  })
})

describe('parseLibrary', () => {
  it('迁移旧结构为当前版本并保留合法记录', () => {
    const raw = JSON.stringify({ reports: [report()] })
    const lib = parseLibrary(raw)
    expect(lib?.version).toBe(1)
    expect(lib?.reports).toHaveLength(1)
  })

  it('丢弃缺少 setId 的脏记录', () => {
    const raw = JSON.stringify({ version: 1, reports: [report(), { completedCount: 3 }] })
    expect(parseLibrary(raw)?.reports).toHaveLength(1)
  })

  it('旧库记录缺快照字段时迁移补齐，仍可读出', () => {
    const legacy = { ...report() } as Record<string, unknown>
    delete legacy.perMetricCoveragePercent
    delete legacy.angleRanges
    delete legacy.calibrationVersion
    delete legacy.ruleVersion
    const raw = JSON.stringify({ version: 1, reports: [legacy] })
    const lib = parseLibrary(raw)
    expect(lib?.reports).toHaveLength(1)
    expect(lib?.reports[0].calibrationVersion).toBe('unknown')
    expect(lib?.reports[0].perMetricCoveragePercent.armGround).toBe(0)
  })

  it('内容损坏返回 null（由调用方备份重建）', () => {
    expect(parseLibrary('{ not json')).toBeNull()
    expect(parseLibrary(JSON.stringify({ foo: 'bar' }))).toBeNull()
  })

  it('旧库（无 v3 快照）迁移后快照为 undefined，仍可读出', () => {
    const legacy = { ...report() } as Record<string, unknown>
    delete legacy.versionSnapshot
    delete legacy.framingWarnings
    const lib = parseLibrary(JSON.stringify({ version: 1, reports: [legacy] }))
    expect(lib?.reports).toHaveLength(1)
    expect(lib?.reports[0].versionSnapshot).toBeUndefined()
  })

  it('含 v3 快照的记录解析后保留快照字段', () => {
    const raw = JSON.stringify({ version: 1, reports: [report({ versionSnapshot: snapshot() })] })
    const lib = parseLibrary(raw)
    expect(lib?.reports[0].versionSnapshot?.advicePolicyVersion).toBe('advice-1')
    expect(lib?.reports[0].versionSnapshot?.modelPrediction?.predictedClass).toBe('PB')
  })
})

describe('mergeReport 幂等写入', () => {
  it('同一组 ID 覆盖更新，不新增重复记录', () => {
    const lib = mergeReport(emptyLibrary(), report())
    const updated = mergeReport(lib, report({ completedCount: 6, polishedText: 'AI 附加' }))
    expect(updated.reports).toHaveLength(1)
    expect(updated.reports[0].completedCount).toBe(6)
    expect(updated.reports[0].polishedText).toBe('AI 附加')
  })

  it('不同组 ID 追加', () => {
    const lib = mergeReport(emptyLibrary(), report())
    const two = mergeReport(lib, report({ setId: 's1-set-2', setIndex: 2 }))
    expect(two.reports).toHaveLength(2)
  })

  it('不改动入参库对象', () => {
    const base = emptyLibrary()
    mergeReport(base, report())
    expect(base.reports).toHaveLength(0)
  })

  it('同 ID 覆盖更新时保留最新版本快照', () => {
    const lib = mergeReport(emptyLibrary(), report({ versionSnapshot: snapshot() }))
    const updated = mergeReport(
      lib,
      report({ versionSnapshot: snapshot({ advicePolicyVersion: 'advice-2' }) })
    )
    expect(updated.reports).toHaveLength(1)
    expect(updated.reports[0].versionSnapshot?.advicePolicyVersion).toBe('advice-2')
  })
})
