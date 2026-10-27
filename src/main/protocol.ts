// 自定义 `app://` 协议：打包后以同源方式加载渲染资源、模型、WASM 与样本，
// 避免使用 file:// 造成的 fetch / importScripts 限制，也不以关闭 webSecurity 规避问题。
//
// 路由约定：
//   app://bundle/<path>  -> 渲染进程构建产物目录（含 wasm/、models/、samples/）
//   app://local/<id>     -> 经主进程授权后的用户本地文件（视频）
import { protocol } from 'electron'
import { open, readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.data': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime'
}

function mimeFor(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/** 注册为特权协议（standard + secure + supportFetchAPI），使其可用于 fetch、Worker 与 importScripts。 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

/** 支持 HTTP Range 的本地文件响应，保证视频可拖动进度。 */
async function serveFile(filePath: string, request: Request): Promise<Response> {
  let info
  try {
    info = await stat(filePath)
  } catch {
    return new Response('Not Found', { status: 404 })
  }
  if (!info.isFile()) return new Response('Not Found', { status: 404 })

  const type = mimeFor(filePath)
  const rangeHeader = request.headers.get('range')
  const match = rangeHeader ? /bytes=(\d*)-(\d*)/.exec(rangeHeader) : null

  if (match) {
    const start = match[1] ? Number.parseInt(match[1], 10) : 0
    const end = match[2] ? Number.parseInt(match[2], 10) : info.size - 1
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= info.size) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${info.size}` }
      })
    }
    const length = end - start + 1
    const handle = await open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, start)
      return new Response(new Uint8Array(buffer), {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(length),
          'Content-Range': `bytes ${start}-${end}/${info.size}`,
          'Accept-Ranges': 'bytes'
        }
      })
    } finally {
      await handle.close()
    }
  }

  const data = await readFile(filePath)
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      'Content-Type': type,
      'Content-Length': String(data.length),
      'Accept-Ranges': 'bytes'
    }
  })
}

/**
 * 安装 `app://` 处理器。
 * @param rendererDir 渲染进程构建产物目录（打包后指向 out/renderer）
 * @param resolveLocal 将授权 id 解析为本地文件绝对路径；未授权返回 undefined
 */
export function handleAppProtocol(
  rendererDir: string,
  resolveLocal: (id: string) => string | undefined
): void {
  const root = normalize(rendererDir)
  protocol.handle('app', async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad Request', { status: 400 })
    }

    if (url.hostname === 'local') {
      const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const filePath = resolveLocal(id)
      if (!filePath) return new Response('Not Found', { status: 404 })
      return serveFile(filePath, request)
    }

    // 默认按 bundle 主机处理，映射到渲染产物目录。
    let relative = decodeURIComponent(url.pathname)
    if (!relative || relative === '/') relative = '/index.html'
    const filePath = normalize(join(root, relative))
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      return new Response('Forbidden', { status: 403 })
    }
    return serveFile(filePath, request)
  })
}
