// 样本获取脚本：从 Mendeley Data 拉取 MyDeadlift 授权样本并生成清单。
//
// 背景：数据集需联网获取，且体积较大，不适合把全部 191 段视频放入发行包。
// 本脚本只下载一份经过筛选、明确标注许可的小规模样本集，并写入 manifest.json。
// 发行包运行时不访问数据集网站；联网下载入口用于后续补充与恢复。
//
// 用法：node scripts/fetch-samples.mjs [--bundle-only]
//   --bundle-only  仅下载随包内置样本（默认行为，downloadable 条目只写入元数据不下载）
//
// 来源：MyDeadlift Dataset, Mendeley Data, DOI 10.17632/w5prmmxyt9.1, CC BY 4.0。
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const samplesDir = join(__dirname, '..', 'resources', 'samples')
const manifestPath = join(samplesDir, 'manifest.json')

const DATASET_ID = 'w5prmmxyt9'
const DATASET_VERSION = 1
const API = `https://data.mendeley.com/public-api/datasets/${DATASET_ID}`
const SOURCE = 'MyDeadlift Dataset (Mendeley Data, DOI 10.17632/w5prmmxyt9.1, CC BY 4.0)'
const LICENSE = 'CC BY 4.0 (Creative Commons Attribution 4.0 International)'
const AUTHOR = 'MyDeadlift Dataset contributors'

// 人工筛选的样本：GB=Correct Movement（正确动作）侧面固定机位、每段一次动作、1920x1080@30fps。
// 按参与者分散选取，用于演示与计数/状态边界观察；不作为判错训练标签使用。
const CURATED = {
  bundled: [
    { file: 'GB_S01_R01.mp4', subject: 'S01', usage: '内置演示：单人单次标准起拉-站直-下放' },
    { file: 'GB_S02_R25.mp4', subject: 'S02', usage: '内置演示：不同身高体型站直判定' },
    { file: 'GB_S03_R36.mp4', subject: 'S03', usage: '内置演示：起拉阶段时长观察' },
    { file: 'GB_S04_R01.mp4', subject: 'S04', usage: '内置演示：下放阶段与节奏' },
    { file: 'GB_S05_R44.mp4', subject: 'S05', usage: '内置演示：躯干倾角变化范围' }
  ],
  downloadable: [
    { file: 'GB_S06_R54.mp4', subject: 'S06', usage: '下载补充：测试子集参与者' },
    { file: 'GB_S07_R11.mp4', subject: 'S07', usage: '下载补充：测试子集参与者' },
    { file: 'GB_S03_R37.mp4', subject: 'S03', usage: '下载补充：同参与者另一段' }
  ]
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

async function download(url, expectedSha, expectedSize) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  if (expectedSize && buffer.length !== expectedSize) {
    throw new Error(`大小不符：期望 ${expectedSize}，实际 ${buffer.length}`)
  }
  if (expectedSha) {
    const actual = sha256(buffer)
    if (actual !== expectedSha) throw new Error(`SHA-256 不符：期望 ${expectedSha}，实际 ${actual}`)
  }
  return buffer
}

function entryFrom(meta, curated, bundled) {
  return {
    file: curated.file,
    originalFile: curated.file,
    source: SOURCE,
    author: AUTHOR,
    license: LICENSE,
    modified: false,
    actualReps: 1,
    mainPhases: ['起拉', '站直', '下放'],
    usage: curated.usage,
    usedForTuning: false,
    concatenated: false,
    person: curated.subject,
    bundled,
    size: meta.content_details.size,
    sha256: meta.content_details.sha256_hash,
    downloadUrl: meta.content_details.download_url,
    contentType: meta.content_details.content_type
  }
}

async function main() {
  const bundleOnly = process.argv.includes('--bundle-only')
  mkdirSync(samplesDir, { recursive: true })

  console.log(`查询数据集元数据：${API}`)
  const meta = await fetchJson(API)
  const byName = new Map()
  for (const f of meta.files) byName.set(f.filename, f)

  const samples = []

  for (const curated of CURATED.bundled) {
    const m = byName.get(curated.file)
    if (!m) {
      console.warn(`跳过：数据集中找不到 ${curated.file}`)
      continue
    }
    const target = join(samplesDir, curated.file)
    if (existsSync(target) && sha256(readFileSync(target)) === m.content_details.sha256_hash) {
      console.log(`已存在且校验通过：${curated.file}`)
    } else {
      process.stdout.write(`下载内置样本 ${curated.file} (${m.content_details.size} B) … `)
      const buffer = await download(m.content_details.download_url, m.content_details.sha256_hash, m.content_details.size)
      writeFileSync(target, buffer)
      console.log('完成')
    }
    samples.push(entryFrom(m, curated, true))
  }

  for (const curated of CURATED.downloadable) {
    const m = byName.get(curated.file)
    if (!m) {
      console.warn(`跳过：数据集中找不到 ${curated.file}`)
      continue
    }
    if (!bundleOnly) {
      const target = join(samplesDir, curated.file)
      if (!existsSync(target)) {
        process.stdout.write(`下载补充样本 ${curated.file} … `)
        const buffer = await download(m.content_details.download_url, m.content_details.sha256_hash, m.content_details.size)
        writeFileSync(target, buffer)
        console.log('完成')
      }
    }
    samples.push(entryFrom(m, curated, false))
  }

  const manifest = {
    description:
      '演示样本清单。仅收录 CC BY 4.0 授权的 MyDeadlift 传统硬拉侧面视频；' +
      '每段为一次动作。bundled=true 的样本随发行包提供，其余可在程序内下载补充。',
    source: SOURCE,
    license: LICENSE,
    datasetUrl: 'https://data.mendeley.com/datasets/w5prmmxyt9/1',
    samples
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  console.log(`清单已写入：${manifestPath}（共 ${samples.length} 条，内置 ${samples.filter((s) => s.bundled).length} 条）`)
}

main().catch((error) => {
  console.error('样本获取失败：', error.message)
  process.exit(1)
})
