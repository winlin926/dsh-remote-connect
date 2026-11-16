import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppServices } from '../../services.js'
import type { Router } from '../router.js'
import { sendHtml } from '../util.js'

/** Shown when the deployment has no `web/` directory (bare API-only setups). */
const FALLBACK_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Remote</title></head>
<body style="font-family:system-ui;max-width:34rem;margin:4rem auto;padding:0 1.5rem;line-height:1.7">
<h1>DSH Remote 节点</h1>
<p>此节点只提供中继 API。请使用 DSH 客户端扫描 Host 显示的配对二维码完成配对。</p>
</body></html>`

interface CachedPage {
  mtimeMs: number
  html: string
}

const pageCache = new Map<string, CachedPage>()

async function readLandingPage(webDir: string): Promise<string> {
  const file = join(webDir, 'index.html')
  try {
    const info = await stat(file)
    const cached = pageCache.get(file)
    if (cached && cached.mtimeMs === info.mtimeMs) return cached.html
    const html = await readFile(file, 'utf8')
    pageCache.set(file, { mtimeMs: info.mtimeMs, html })
    return html
  } catch {
    return FALLBACK_HTML
  }
}

/** Minimal landing page for the QR flow; the page itself calls the JSON API. */
export function registerLandingRoutes(router: Router, services: AppServices): void {
  const { config } = services

  const render = async (ctx: Parameters<Parameters<Router['add']>[2]>[0]): Promise<void> => {
    const html = await readLandingPage(config.webDir)
    sendHtml(ctx.res, 200, html, { head: ctx.head, cacheControl: 'no-store' })
  }

  router.add('GET', '/', render)
  router.add('GET', '/pair', render)

  router.add('GET', '/favicon.ico', ctx => {
    ctx.res.writeHead(204, { 'cache-control': 'public, max-age=86400' })
    ctx.res.end()
  })
}
