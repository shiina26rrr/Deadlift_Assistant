// CR06：同一关键点序列经训练端（training/analysis_protocol.py）与运行端
// （AnalysisOrchestrator + extractFeatures）后，动作起止、位移、覆盖率与特征缺失标记一致。
// 夹具由 `py training/make_protocol_parity_fixture.py` 生成；训练端可用
// `py training/check_protocol_parity.py` 复核。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AnalysisOrchestrator } from '@renderer/analysis/orchestrator'
import { FEATURE_ORDER, extractFeatures } from '@renderer/analysis/actionModelRuntime'
import { cloneDefaultConfig } from '@shared/config'
import type { FeatureSpec, NormalizedLandmark } from '@shared/types'

interface RawFrame {
  timestamp: number
  landmarks: number[][]
  hasPose: boolean
}

interface ExpectedSegment {
  startMs: number
  endMs: number
  frameCount: number
  validRatio: number
  displacement: { shoulder: number | null; hip: number | null }
  durationSec: number
  angles: Record<string, number | null>
}

interface Case {
  id: string
  frames: RawFrame[]
  expected: { segments: ExpectedSegment[] }
}

const root = process.cwd()
const fixture = JSON.parse(
  readFileSync(resolve(root, 'tests/fixtures/protocol-parity.json'), 'utf-8')
) as { frameSize: { width: number; height: number }; cases: Case[] }

const spec = { order: [...FEATURE_ORDER] } as FeatureSpec

function toLandmarks(raw: number[][]): NormalizedLandmark[] {
  return raw.map(([x, y, visibility]) => ({ x, y, z: 0, visibility }))
}

function analyze(frames: RawFrame[]): AnalysisOrchestrator {
  const orchestrator = new AnalysisOrchestrator(cloneDefaultConfig(), () => undefined)
  orchestrator.begin(0)
  for (const frame of frames) {
    if (frame.hasPose) {
      orchestrator.processFrame(toLandmarks(frame.landmarks), fixture.frameSize, frame.timestamp)
    } else {
      orchestrator.invalidateFrame(frame.timestamp)
    }
  }
  return orchestrator
}

function expectNumber(actual: number, expected: number | null, label: string): void {
  if (expected === null) {
    expect(Number.isFinite(actual), `${label} 应为缺失`).toBe(false)
  } else {
    expect(actual, label).toBeCloseTo(expected, 6)
  }
}

describe('训练端/运行端动作分段与特征一致性（CR06）', () => {
  for (const testCase of fixture.cases) {
    it(testCase.id, () => {
      const orchestrator = analyze(testCase.frames)
      const actions = orchestrator.segmentedActions
      expect(actions.length).toBe(testCase.expected.segments.length)

      actions.forEach((action, index) => {
        const expected = testCase.expected.segments[index]
        expect(action.startMs, `${testCase.id}#${index} start`).toBeCloseTo(expected.startMs, 6)
        expect(action.endMs, `${testCase.id}#${index} end`).toBeCloseTo(expected.endMs, 6)
        expect(action.frames.length, `${testCase.id}#${index} frameCount`).toBe(expected.frameCount)
        expect(action.validRatio, `${testCase.id}#${index} validRatio`).toBeCloseTo(
          expected.validRatio,
          6
        )
        expectNumber(
          action.displacement.shoulder,
          expected.displacement.shoulder,
          `${testCase.id}#${index} displacement.shoulder`
        )
        expectNumber(
          action.displacement.hip,
          expected.displacement.hip,
          `${testCase.id}#${index} displacement.hip`
        )

        const features = extractFeatures(action, null, spec)
        expect(features).not.toBeNull()
        for (const [name, value] of Object.entries(expected.angles)) {
          const featureIndex = FEATURE_ORDER.indexOf(name as (typeof FEATURE_ORDER)[number])
          expect(featureIndex, `${testCase.id}#${index} 未知特征 ${name}`).toBeGreaterThanOrEqual(0)
          expectNumber((features as number[])[featureIndex], value, `${testCase.id}#${index} ${name}`)
        }
        expectNumber(
          (features as number[])[FEATURE_ORDER.indexOf('durationSec')],
          expected.durationSec,
          `${testCase.id}#${index} durationSec`
        )
        // 未提供比例参考 → 三个比例特征必须保持缺失（NaN），不得用 0 填充。
        for (const name of [
          'proportionThighToShin',
          'proportionTrunkToLeg',
          'proportionArmToTrunk'
        ] as const) {
          const value = (features as number[])[FEATURE_ORDER.indexOf(name)]
          expect(Number.isFinite(value), `${testCase.id}#${index} ${name} 应为缺失`).toBe(false)
        }
      })
    })
  }
})
