import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const PREVIEW_PREFIX = '/rc/workspace-preview/'
const IDLE_TIME = 2 * 60 * 60 * 1000
const MAX_SITES = 32

export const PREVIEW_MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8', webmanifest: 'application/manifest+json',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif', bmp: 'image/bmp',
  pdf: 'application/pdf', wasm: 'application/wasm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
}

interface PreviewSite {
  deviceId: string
  root: string
  lastUsed: number
}
export interface PreviewRequest {
  deviceId: string
  root: string
  path: string
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}

/** Capability URLs let sandboxed module scripts load without the remote-control cookie. */
export class WorkspacePreviews {
  private readonly sites = new Map<string, PreviewSite>()

  add(token: string, deviceId: string, root: string): void {
    this.sites.delete(token)
    if (this.sites.size >= MAX_SITES) this.sites.delete(this.sites.keys().next().value!)
    this.sites.set(token, { deviceId, root, lastUsed: Date.now() })
  }

  match(pathname: string): PreviewRequest | undefined {
    if (!pathname.startsWith(PREVIEW_PREFIX)) return undefined
    const rest = pathname.slice(PREVIEW_PREFIX.length)
    const slash = rest.indexOf('/')
    if (slash < 1 || slash === rest.length - 1) return undefined
    const token = rest.slice(0, slash)
    const site = this.sites.get(token)
    if (!site) return undefined
    if (Date.now() - site.lastUsed > IDLE_TIME) { this.sites.delete(token); return undefined }
    this.sites.delete(token); this.sites.set(token, { ...site, lastUsed: Date.now() })
    return { deviceId: site.deviceId, root: site.root, path: rest.slice(slash + 1) }
  }

  revoke(deviceId: string): void {
    for (const [token, site] of this.sites) if (site.deviceId === deviceId) this.sites.delete(token)
  }

  clear(): void { this.sites.clear() }

  async serve(preview: PreviewRequest, req: IncomingMessage, res: ServerResponse): Promise<void> {
    let relativePath: string
    try { relativePath = decodeURIComponent(preview.path) } catch { res.writeHead(400); res.end(); return }
    const candidate = resolve(preview.root, ...relativePath.split('/'))
    if (!inside(preview.root, candidate)) { res.writeHead(404); res.end(); return }
    try {
      const path = await realpath(candidate)
      const info = await stat(path)
      if (!inside(preview.root, path) || !info.isFile()) { res.writeHead(404); res.end(); return }
      const mime = PREVIEW_MIME[path.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream'
      const headers: Record<string, string | number> = {
        'content-type': mime, 'content-length': info.size, 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        'origin-agent-cluster': '?1', 'access-control-allow-origin': 'null',
      }
      // The opaque origin can run the artifact but cannot use DSH cookies, storage or APIs.
      if (mime.startsWith('text/html')) headers['content-security-policy'] = 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads'
      res.writeHead(200, headers)
      if (req.method === 'HEAD') { res.end(); return }
      const stream = createReadStream(path)
      stream.on('error', () => res.destroy())
      res.once('close', () => stream.destroy())
      stream.pipe(res)
    } catch {
      if (!res.headersSent) { res.writeHead(404); res.end() } else res.destroy()
    }
  }
}

export function previewEntry(path: string): string {
  return encodeURIComponent(basename(path))
}
