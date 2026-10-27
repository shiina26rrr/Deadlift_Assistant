import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSafeSampleName, parseManifest } from '@shared/sampleManifest'
import type { SampleManifestEntry } from '@shared/types'

function entry(file: string): SampleManifestEntry {
  return {
    file,
    originalFile: file,
    source: 'src',
    author: 'author',
    license: 'CC BY 4.0',
    modified: false,
    actualReps: 1,
    mainPhases: ['起拉'],
    usage: 'demo',
    usedForTuning: false,
    concatenated: false
  }
}

describe('parseManifest', () => {
  it('解析含 samples 数组的对象结构', () => {
    const raw = JSON.stringify({ description: 'd', samples: [entry('a.mp4'), entry('b.mp4')] })
    const list = parseManifest(raw)
    expect(list).toHaveLength(2)
    expect(list[0].file).toBe('a.mp4')
  })

  it('兼容历史顶层数组写法', () => {
    const raw = JSON.stringify([entry('a.mp4')])
    expect(parseManifest(raw)).toHaveLength(1)
  })

  it('结构非法或 JSON 损坏时返回空数组', () => {
    expect(parseManifest('{ not json')).toEqual([])
    expect(parseManifest(JSON.stringify({ foo: 'bar' }))).toEqual([])
    expect(parseManifest(JSON.stringify({ samples: 'nope' }))).toEqual([])
  })

  it('丢弃缺少 file 的条目', () => {
    const raw = JSON.stringify({ samples: [entry('a.mp4'), { usage: 'x' }] })
    expect(parseManifest(raw)).toHaveLength(1)
  })
})

describe('内置样本清单（resources/samples/manifest.json）', () => {
  const samplesDir = fileURLToPath(new URL('../resources/samples', import.meta.url))
  const raw = readFileSync(join(samplesDir, 'manifest.json'), 'utf8')
  const entries = parseManifest(raw)

  it('对象结构可被解析，且至少含 3 段预置样本', () => {
    expect(entries.length).toBeGreaterThanOrEqual(3)
    expect(entries.filter((e) => e.bundled).length).toBeGreaterThanOrEqual(3)
  })

  it('随包样本文件真实存在，且名字安全', () => {
    for (const e of entries.filter((x) => x.bundled)) {
      expect(isSafeSampleName(e.file)).toBe(true)
      expect(existsSync(join(samplesDir, e.file))).toBe(true)
    }
  })

  it('样本说明与许可可查', () => {
    for (const e of entries) {
      expect(e.license).toContain('CC BY 4.0')
      expect(e.usage.length).toBeGreaterThan(0)
      expect(e.person.length).toBeGreaterThan(0)
    }
  })

  it('可下载样本带校验信息（下载地址/大小/摘要）', () => {
    for (const e of entries.filter((x) => !x.bundled)) {
      expect(e.downloadUrl).toBeTruthy()
      expect(e.size).toBeGreaterThan(0)
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe('isSafeSampleName', () => {
  it('接受纯文件名', () => {
    expect(isSafeSampleName('GB_S01_R01.mp4')).toBe(true)
  })

  it('拒绝路径穿越与空名', () => {
    expect(isSafeSampleName('../secret.mp4')).toBe(false)
    expect(isSafeSampleName('a/b.mp4')).toBe(false)
    expect(isSafeSampleName('a\\b.mp4')).toBe(false)
    expect(isSafeSampleName('')).toBe(false)
    expect(isSafeSampleName('..')).toBe(false)
  })
})
