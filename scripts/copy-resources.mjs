// 资源准备脚本：把 MediaPipe 的 WASM 运行时复制到 resources/wasm，
// 并在缺失时下载 Pose Landmarker 模型。资源最终由 Vite 复制进发行包，
// 应用运行时不再访问任何远程地址。
import { createWriteStream } from 'node:fs'
import { mkdir, copyFile, readdir, stat } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const resources = join(root, 'resources')
const wasmDir = join(resources, 'wasm')
const modelDir = join(resources, 'models')

// 与 @mediapipe/tasks-vision 版本对应的官方模型地址（float16，lite 版）。
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'
const MODEL_NAME = 'pose_landmarker_lite.task'
// 官方 lite 模型字节数，用于判断下载是否完整（支持断点续传）。
const MODEL_SIZE = 5777746

function download(url, dest, redirects = 0) {
  return new Promise((resolvePromise, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'))
    const startAt = existsSync(dest) ? Math.max(0, statSync(dest).size) : 0
    const headers = startAt > 0 && startAt < MODEL_SIZE ? { Range: `bytes=${startAt}-` } : {}
    https
      .get(url, { timeout: 60000, headers }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          return resolvePromise(download(res.headers.location, dest, redirects + 1))
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        }
        const resuming = res.statusCode === 206 && startAt > 0
        const total = Number(res.headers['content-length'] || 0) + (resuming ? startAt : 0)
        let received = resuming ? startAt : 0
        let lastPct = -1
        const out = createWriteStream(dest, resuming ? { flags: 'a' } : {})
        res.on('data', (chunk) => {
          received += chunk.length
          if (total) {
            const pct = Math.floor((received / total) * 100)
            if (pct >= lastPct + 5) {
              lastPct = pct
              process.stdout.write(`\r  下载 ${MODEL_NAME} ... ${pct}%`)
            }
          }
        })
        res.pipe(out)
        out.on('finish', () => {
          process.stdout.write('\r')
          out.close(() => resolvePromise(dest))
        })
        out.on('error', reject)
      })
      .on('timeout', function () {
        this.destroy(new Error('timeout'))
      })
      .on('error', reject)
  })
}

async function main() {
  await mkdir(wasmDir, { recursive: true })
  await mkdir(modelDir, { recursive: true })

  const visionWasm = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
  if (existsSync(visionWasm)) {
    for (const f of await readdir(visionWasm)) {
      await copyFile(join(visionWasm, f), join(wasmDir, f))
    }
    console.log(`已复制 WASM 运行时：${(await readdir(wasmDir)).length} 个文件 -> resources/wasm`)
  } else {
    console.warn('未找到 node_modules/@mediapipe/tasks-vision/wasm，请先运行依赖安装。')
  }

  const modelPath = join(modelDir, MODEL_NAME)
  if (existsSync(modelPath) && (await stat(modelPath)).size === MODEL_SIZE) {
    console.log(`模型已存在且完整：resources/models/${MODEL_NAME}`)
  } else {
    console.log('正在下载 Pose Landmarker 模型（约 5.7MB，支持断点续传）...')
    // 多次尝试以应对不稳定网络。
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        await download(MODEL_URL, modelPath)
        break
      } catch (err) {
        console.warn(`\n  第 ${attempt} 次下载中断：${err.message}`)
        if (attempt === 5) throw err
      }
    }
    const size = statSync(modelPath).size
    console.log(`模型已保存：resources/models/${MODEL_NAME} (${size} 字节)`)
  }
}

main().catch((err) => {
  console.error('资源准备失败：', err.message)
  process.exitCode = 1
})
