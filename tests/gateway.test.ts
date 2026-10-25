import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { Gateway, MANAGE_PATH, safePath } from '../src/gateway.js'
import { PairingService } from '../src/pairing.js'
const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-rc-gateway-')); cleanup.push(() => rmSync(folder, { recursive: true, force: true }))
  let gateway: Gateway; let calls = 0
  const reports: Array<{ report: Record<string, unknown>; device?: { id: string; name: string } }> = []
  const pairing = new PairingService({ file: join(folder, 'devices.json'), onRevoke: id => gateway.revoke(id) })
  const upstream = createServer((req, res) => {
    calls++
    if (req.url?.startsWith('/api/sse')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('id: 1\ndata: 第一条\n\n'); const timer = setInterval(() => res.write('event: tick\ndata: second\n\n'), 50); res.once('close', () => clearInterval(timer)); return }
    if (req.url === '/api/hold') { res.writeHead(200); res.write('start'); return }
    if (req.url === '/api/upload') { let size = 0; req.on('data', chunk => size += chunk.length); req.on('end', () => res.end(JSON.stringify({ size }))); return }
    res.setHeader('set-cookie', 'host-secret=should-never-reach-client'); res.end(JSON.stringify({ cookie: req.headers.cookie, origin: req.headers.origin }))
  })
  const wss = new WebSocketServer({ server: upstream }); wss.on('connection', ws => ws.on('message', (data, binary) => ws.send(data, { binary })))
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { for (const client of wss.clients) client.terminate(); wss.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
  const port = (upstream.address() as { port: number }).port
  gateway = new Gateway({ pairing, upstreamPort: port, upstreamCookie: () => 'host-private=secret', manage: async (input, local) => { if (input.action === 'approve' && !local) throw new Error('本机确认'); return { local } }, index: async ui => `<html><head></head><body>official shell; ui=${ui ?? 'default'}</body></html>`, onBootReport: (report, device) => reports.push({ report, device }) })
  await gateway.listen('127.0.0.1'); cleanup.push(() => gateway.close())
  const base = `http://127.0.0.1:${gateway.port}`
  const claim = pairing.request(pairing.issue().token, 'Android'); pairing.approve(claim.id)
  const credential = pairing.claim(claim.id, claim.key).credential!
  return { base, pairing, gateway, credential, folder, calls: () => calls, cookie: `dsh_rc=${credential}`, reports }
}
describe('gateway admission and transport', () => {
  it('refuses unauthenticated requests without reaching the Host', async () => {
    const f = await fixture(); const response = await fetch(`${f.base}/api/secrets`)
    expect(response.status).toBe(403); expect(f.calls()).toBe(0)
  })
  it('rejects Host spoofing and cross-origin requests', async () => {
    const f = await fixture()
    const spoofed = await new Promise<number | undefined>(resolve => {
      const req = request(`${f.base}/api/x`, { headers: { cookie: f.cookie, host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode) }); req.end()
    })
    expect(spoofed).toBe(403)
    expect((await fetch(`${f.base}/api/x`, { headers: { cookie: f.cookie, origin: 'https://evil.example' } })).status).toBe(403)
    expect(f.calls()).toBe(0)
  })
  it('never forwards device cookies or returns Host cookies', async () => {
    const f = await fixture(); const response = await fetch(`${f.base}/api/data`, { headers: { cookie: f.cookie, 'x-forwarded-host': 'evil.example' } })
    const data = await response.json()
    expect(data.cookie).toBe('host-private=secret'); expect(data.cookie).not.toContain(f.credential)
    expect(response.headers.get('set-cookie')).not.toContain('host-secret')
  })
  it('serves a gated official shell with boot hooks before scripts', async () => {
    const f = await fixture(), response = await fetch(f.base, { headers: { cookie: f.cookie } }), html = await response.text()
    expect(html).toContain('__DSH_TRANSPORT__'); expect(html).toContain('official shell'); expect(html).not.toContain(f.credential)
  })
  it('opens a complete local HTML site in an isolated temporary preview', async () => {
    const f = await fixture(), site = join(f.folder, 'site')
    mkdirSync(join(site, 'assets'), { recursive: true })
    writeFileSync(join(site, 'index.html'), '<link rel="stylesheet" href="assets/site.css"><script type="module" src="assets/site.js"></script>')
    writeFileSync(join(site, 'assets', 'site.css'), 'body { color: rgb(1, 2, 3) }')
    writeFileSync(join(site, 'assets', 'site.js'), 'export const loaded = true')
    writeFileSync(join(f.folder, 'outside.txt'), 'outside')
    const opened = await fetch(`${f.base}/rc/workspace-file?p=${encodeURIComponent(join(site, 'index.html'))}`, { headers: { cookie: f.cookie }, redirect: 'manual' })
    expect(opened.status).toBe(303)
    const location = opened.headers.get('location')!
    expect(location).toMatch(/^\/rc\/workspace-preview\/[A-Za-z0-9_-]{43}\/index\.html$/)
    expect(location).not.toContain(f.credential)
    expect((await fetch(f.base + location)).status).toBe(200)
    // The capability path, rather than the DSH cookie, works with an opaque origin.
    const html = await fetch(f.base + location, { headers: { cookie: f.cookie, origin: 'null' } })
    expect(html.status).toBe(200)
    expect(html.headers.get('content-security-policy')).toContain('sandbox allow-scripts')
    expect(html.headers.get('content-security-policy')).not.toContain('allow-same-origin')
    expect(html.headers.get('origin-agent-cluster')).toBe('?1')
    const base = location.slice(0, location.lastIndexOf('/'))
    const css = await fetch(`${f.base}${base}/assets/site.css`, { headers: { origin: 'null' } })
    expect(css.status).toBe(200); expect(css.headers.get('content-type')).toContain('text/css')
    expect(await css.text()).toContain('rgb(1, 2, 3)')
    expect((await fetch(`${f.base}${base}/assets/site.css`, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'style' } })).status).toBe(200)
    const module = await fetch(`${f.base}${base}/assets/site.js`, { headers: { origin: 'null' } })
    expect(module.status).toBe(200); expect(module.headers.get('access-control-allow-origin')).toBe('null')
    expect((await fetch(`${f.base}${base}/assets/site.js`, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await fetch(`${f.base}${base}/%2e%2e/outside.txt`, { headers: { origin: 'null' } })).status).toBe(404)
    expect((await fetch(`${f.base}${base}/`, { method: 'HEAD', headers: { origin: 'null' } })).status).toBe(404)
    f.pairing.revoke(f.pairing.list()[0]!.id)
    expect((await fetch(f.base + location, { headers: { cookie: f.cookie, origin: 'null' } })).status).toBe(404)
  })
  it('expires unused preview capabilities and keeps resources inside their real directory', async () => {
    const f = await fixture(), site = join(f.folder, 'site')
    mkdirSync(site); writeFileSync(join(site, 'index.html'), '<p>page</p>')
    writeFileSync(join(f.folder, 'secret.txt'), 'not part of the preview')
    const open = async () => {
      const response = await fetch(`${f.base}/rc/workspace-file?p=${encodeURIComponent(join(site, 'index.html'))}`, { headers: { cookie: f.cookie }, redirect: 'manual' })
      return response.headers.get('location')!
    }
    const location = await open()
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000 + 1)
    try { expect((await fetch(f.base + location)).status).toBe(404) } finally { vi.useRealTimers() }
    const next = await open(), escaped = next.replace('/index.html', '/%252e%252e/secret.txt')
    expect((await fetch(f.base + escaped)).status).toBe(403)
    const other = next.replace('/index.html', '/%2Fetc%2Fpasswd')
    expect((await fetch(f.base + other)).status).toBe(404)
    await f.gateway.close()
    await expect(fetch(f.base + next)).rejects.toThrow()
  })
  it('selects native/custom UI only after authorization and ignores unknown UI values', async () => {
    const f = await fixture()
    expect((await fetch(f.base + '/?ui=native')).status).toBe(403)
    for (const [query, selected] of [['native', 'native'], ['custom', 'custom'], ['evil', 'default']]) {
      const response = await fetch(`${f.base}/?ui=${query}`, { headers: { cookie: f.cookie } })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain(`ui=${selected}`)
    }
    expect(f.calls()).toBe(0)
  })
  it('refuses remote approvals including encoded management paths', async () => {
    const f = await fixture()
    for (const path of [MANAGE_PATH, '/api/%64sh-remote-control/manage']) {
      expect((await fetch(f.base + path, { method: 'POST', headers: { cookie: f.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve' }) })).status).toBe(400)
    }
    expect(f.calls()).toBe(0)
  })
  it('streams binary uploads without JSON conversion', async () => {
    const f = await fixture(), data = new Uint8Array(262144).fill(251)
    const response = await fetch(`${f.base}/api/upload`, { method: 'POST', headers: { cookie: f.cookie }, body: data })
    expect(await response.json()).toEqual({ size: data.length })
  })
  it('forwards WS text and binary, then closes both legs on revocation', async () => {
    const f = await fixture(), ws = new WebSocket(f.base.replace('http:', 'ws:') + '/api/remote.mux', { headers: { cookie: f.cookie, origin: f.base } })
    await once(ws, 'open'); ws.send('hello'); expect(String((await once(ws, 'message'))[0])).toBe('hello')
    const bytes = Buffer.from([0, 128, 255]); ws.send(bytes); expect((await once(ws, 'message'))[0]).toEqual(bytes)
    const closed = once(ws, 'close'); f.pairing.revoke(f.pairing.list()[0]!.id); await closed
    expect((await fetch(`${f.base}/api/data`, { headers: { cookie: f.cookie } })).status).toBe(403)
  })
  it('rejects unpaired WS before opening upstream', async () => {
    const f = await fixture(), ws = new WebSocket(f.base.replace('http:', 'ws:') + '/api/remote.mux')
    ws.on('error', () => {}); const [, response] = await once(ws, 'unexpected-response'); expect(response.statusCode).toBe(403); ws.terminate()
  })
  it('bridges non-ending SSE incrementally over WS and cancels on revoke', async () => {
    const f = await fixture(), ws = new WebSocket(f.base.replace('http:', 'ws:') + '/rc/sse?path=%2Fapi%2Fsse', { headers: { cookie: f.cookie, origin: f.base } })
    const frames: Array<{ type: string; data?: string }> = []; ws.on('message', data => frames.push(JSON.parse(String(data))))
    await once(ws, 'open'); await new Promise(resolve => setTimeout(resolve, 150))
    expect(frames.some(frame => frame.type === 'ready')).toBe(true)
    expect(frames.some(frame => frame.data?.includes('第一条'))).toBe(true)
    const closed = once(ws, 'close'); f.pairing.revokeAll(); await closed
  })
  it('admits the official plugin SSE path through the authenticated bridge', async () => {
    const f = await fixture(), ws = new WebSocket(f.base.replace('http:', 'ws:') + '/rc/sse?path=%2Fplugins%2Fevents', { headers: { cookie: f.cookie, origin: f.base } })
    const frames: Array<{ type: string }> = []; ws.on('message', data => frames.push(JSON.parse(String(data))))
    await once(ws, 'open'); await new Promise(resolve => setTimeout(resolve, 100))
    // This mock endpoint returns non-SSE, so the bridge must reach it then reject it.
    expect(f.calls()).toBe(1); expect(frames.some(frame => frame.type === 'error')).toBe(true)
  })
  it('destroys in-flight HTTP and WS when stopping, while keeping authorization', async () => {
    const f = await fixture(), controller = new AbortController()
    const response = await fetch(`${f.base}/api/hold`, { headers: { cookie: f.cookie }, signal: controller.signal })
    const completion = response.text(); const failed = completion.catch(() => 'closed')
    await f.gateway.close(); expect(await failed).toBe('closed'); expect(f.pairing.authenticate(f.credential)).toBeDefined()
  })
  it('does not expose the public-domain health identity on a loopback-only gateway', async () => {
    const f = await fixture()
    expect((await fetch(f.base + '/rc/health')).status).toBe(404)
  })
  it('accepts boot diagnostics from unpaired devices and marks the reporter only when paired', async () => {
    const f = await fixture()
    const json = { 'content-type': 'application/json' }
    expect((await fetch(f.base + '/rc/boot-report', { method: 'POST', headers: json, body: JSON.stringify({ errors: ['资源加载失败: <script> x'] }) })).status).toBe(204)
    expect((await fetch(f.base + '/rc/boot-report', { method: 'POST', headers: { ...json, origin: f.base, cookie: f.cookie }, body: JSON.stringify({ errors: [] }) })).status).toBe(204)
    expect((await fetch(f.base + '/rc/boot-report', { method: 'POST', headers: { ...json, origin: 'https://evil.example' }, body: '{}' })).status).toBe(403)
    expect((await fetch(f.base + '/rc/boot-report')).status).toBe(403)
    expect(f.reports).toHaveLength(2)
    expect(f.reports[0]!.device).toBeUndefined()
    expect(f.reports[1]!.device).toEqual({ id: expect.any(String), name: expect.any(String) })
    expect(f.reports[0]!.report.errors).toEqual(['资源加载失败: <script> x'])
  })
})
it('rejects traversal and malformed paths', () => {
  for (const path of ['//evil', '/a/../b', '/a/%2e%2e/b', '/a/%252e%252e/b', '/a%5cb', '/%00', '/%xx']) expect(safePath(path)).toBe(false)
  expect(safePath('/api/session/uploadFileBinary?name=a%20b')).toBe(true)
})
