import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import * as Plugin from '../src/index.js'
import { MANAGE_PATH } from '../src/gateway.js'
import { Gateway } from '../src/gateway.js'
import { PUBLIC_PORT } from '../src/public-access.js'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER = { principal: { kind: "owner" } } as Connection.PeerScope

it('creates a private HTTP adapter for a carrier-only Host and handles trusted Desktop Fetch', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-rc-host-')), previous = process.env.DSH_HOME
  process.env.DSH_HOME = folder
  const ctx = new Context()
  let record: unknown
  const removeCredentials = ctx.provide('credentials', { modifyRecord: async (_key: unknown, update: (value: unknown) => Promise<unknown>) => { const next = await update(record); if (next !== undefined) record = next; return record } })
  try {
    await ctx.plugin(Connection, {})
    expect(ctx.get('webServer')).toBeUndefined()
    await ctx.plugin(Plugin, {})
    let result: Response | undefined
    for (let attempt = 0; attempt < 100; attempt++) {
      if (ctx.get('webServer')?.port) {
        result = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request('http://desktop.internal' + MANAGE_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'status' }) }), OWNER)
        if (result.status === 200) break
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(result?.status).toBe(200)
    expect(await result!.json()).toMatchObject({ local: true, enabled: false, autoStart: false })
    expect(ctx.get('webServer')?.host).toBe('127.0.0.1')
    const port = ctx.get('webServer')!.port
    expect((await fetch(`http://127.0.0.1:${port}${MANAGE_PATH}`, { method: 'POST' })).status).toBe(401)
  } finally {
    ctx.registry.delete(Plugin); ctx.registry.delete(Connection); await new Promise(resolve => setTimeout(resolve, 30)); await removeCredentials()
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    rmSync(folder, { recursive: true, force: true })
  }
})

async function withHost(run: (command: (action: string, fields?: Record<string, unknown>) => Promise<any>, ctx: Context) => Promise<void>, config: Plugin.Config = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-rc-switch-')), previous = process.env.DSH_HOME
  process.env.DSH_HOME = folder
  const ctx = new Context(); let record: unknown
  const remove = ctx.provide('credentials', { modifyRecord: async (_key: unknown, update: (value: unknown) => Promise<unknown>) => { const next = await update(record); if (next !== undefined) record = next; return record } })
  try {
    await ctx.plugin(Connection, {}); await ctx.plugin(Plugin, { certificateDir: join(folder, 'certificates'), ...config })
    const command = async (action: string, fields: Record<string, unknown> = {}) => {
      const response = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request('http://desktop.internal' + MANAGE_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...fields }) }), OWNER)
      const data = await response.json(); return { ...data, status: response.status }
    }
    await vi.waitFor(async () => expect((await command('status')).status).toBe(200))
    await run(command, ctx)
  } finally {
    ctx.registry.delete(Plugin); ctx.registry.delete(Connection); await new Promise(resolve => setTimeout(resolve, 100)); await remove(); vi.restoreAllMocks()
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    rmSync(folder, { recursive: true, force: true })
  }
}

it('ignores the retired phone-interface preference without restarting the live gateway', async () => withHost(async command => {
  expect((await command('status')).ui).toBeUndefined()
  await command('preferences', { mode: 'lan' }); const started = await command('start')
  const saved = await command('preferences', { ui: 'native' })
  expect(saved).toMatchObject({ gatewayPort: started.gatewayPort, enabled: true })
  expect(saved.ui).toBeUndefined()
  expect(saved.links).toEqual(started.links)
}))

it('keeps the running LAN entry and QR while saving a different mode or proxy', async () => withHost(async command => {
  await command('preferences', { mode: 'lan' })
  const started = await command('start')
  const selected = await command('preferences', { mode: 'public', proxy: 'http://127.0.0.1:7890', autoStart: true })
  expect(selected).toMatchObject({ enabled: true, mode: 'public', activeMode: 'lan', gatewayPort: started.gatewayPort })
  expect(selected.links).toEqual(started.links); expect(selected.qr).toBe(started.qr)
  const failed = await command('preferences', { mode: 'nonsense' })
  expect(failed.status).toBe(400)
  expect((await command('status')).links).toEqual(started.links)
}))

it('keeps a waiting pairing request when the QR is refreshed', async () => withHost(async command => {
  await command('preferences', { mode: 'lan' }); const state = await command('start')
  const base = `http://127.0.0.1:${state.gatewayPort}`
  const request = await (await fetch(base + '/rc/pair/request', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ token: new URL(state.links[0].url).hash.slice(6) }) })).json()
  expect((await command('refresh')).status).toBe(400)
  expect((await command('status')).requests).toHaveLength(1)
  await command('reject', { id: request.id })
  expect((await command('refresh')).status).toBe(200)
}))

it('explicitly switches entries, invalidates the old entry, and can retry a failed switch', async () => withHost(async command => {
  await command('preferences', { mode: 'lan' }); const lan = await command('start')
  await command('preferences', { mode: 'public', publicUrl: 'https://dsh.example.com' }); const publicEntry = await command('switch')
  expect(publicEntry).toMatchObject({ activeMode: 'public', phase: 'ready', mode: 'public' })
  // Public mode always uses the frpc target port, not the temporary LAN port.
  expect(publicEntry.gatewayPort).toBe(PUBLIC_PORT)
  expect(publicEntry.publicPort).toBe(PUBLIC_PORT)
  expect(publicEntry.links[0].base).toBe('https://dsh.example.com')
  expect(await fetch(`http://127.0.0.1:${lan.gatewayPort}/`).then(response => response.status, () => 0)).not.toBe(200)
  await command('preferences', { mode: 'lan' }); const switched = await command('switch')
  expect(switched).toMatchObject({ activeMode: 'lan', enabled: true, phase: 'ready' })
  expect(switched.links[0].url).not.toBe(lan.links[0].url)
  vi.spyOn(Gateway.prototype, 'listen').mockRejectedValueOnce(new Error('test address unavailable'))
  await command('preferences', { mode: 'public' }); expect((await command('switch')).status).toBe(400)
  expect(await command('status')).toMatchObject({ enabled: false, phase: 'error', error: 'test address unavailable' })
  expect((await command('start')).activeMode).toBe('public')
}))

it('confirms the public node on both ends before issuing a device cookie', async () => withHost(async command => {
  await command('preferences', { mode: 'public', publicUrl: 'https://dsh.example.com' })
  const state = await command('start')
  expect(state.node).toMatchObject({ kind: 'gateway', protocol: 2, fingerprint: expect.stringMatching(/^[a-f0-9]{32}$/), fingerprintGroups: expect.stringMatching(/^([A-F0-9]{4}-){7}[A-F0-9]{4}$/) })
  const send = (path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST') => new Promise<{ status: number; body: any; text: string; cookie: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: state.gatewayPort, path, method, headers: { host: 'dsh.example.com', origin: 'https://dsh.example.com', 'content-type': 'application/json', ...headers } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text.startsWith('{') ? JSON.parse(text) : {}, text, cookie: res.headers['set-cookie']?.[0] ?? '' }))
    }); req.on('error', reject); req.end(method === 'GET' ? undefined : JSON.stringify(body))
  })
  // The page the browser reaches first names this node, not the Host behind it.
  const page = await send('/pair', undefined, { accept: 'text/html' }, 'GET')
  expect(page.status).toBe(200)
  for (const text of ['确认是本机', state.node.fingerprintGroups, '隧道网关', 'v2', '目标主机指纹']) expect(page.text).toContain(text)
  const discovery = await send('/.well-known/dsh-remote', undefined, {}, 'GET')
  expect(discovery.status).toBe(200)
  expect(discovery.body).toMatchObject({
    protocol: 2, kind: 'gateway', name: 'DeepSeek Harness',
    node: { id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), fingerprint: state.node.fingerprint, publicKey: expect.stringMatching(/^[A-Za-z0-9_-]{40,120}$/) },
  })
  // The flat fields stay as compatibility aliases for clients up to 0.5.0; they repeat the node identity.
  expect(discovery.body.hostId).toBe(discovery.body.node.id)
  expect(discovery.body.fingerprint).toBe(state.node.fingerprint)
  const token = new URL(state.links[0].url).hash.slice(6)
  // A page that did not confirm this host's fingerprint cannot even ask for a ticket.
  const mismatched = await send('/rc/pair/request', { token, fingerprint: '0'.repeat(32) })
  expect(mismatched.status).toBe(403); expect(mismatched.body.code).toBe('fingerprint_mismatch')
  expect((await command('status')).pairingFailure.reason).toContain('指纹')
  const pairRequest = await send('/rc/pair/request', { token, fingerprint: state.node.fingerprint })
  expect(pairRequest.status).toBe(200)
  const pending = (await command('status')).requests[0]
  expect(pending).toMatchObject({ id: pairRequest.body.id, via: 'public', nodeConfirmed: true, name: '远程设备' })
  // The computer confirms the same device name and the same fingerprint; anything else is refused.
  const wrongName = await command('approve', { id: pairRequest.body.id, name: '另一台设备', fingerprint: state.node.fingerprint })
  expect(wrongName.status).toBe(400)
  expect((await command('status')).requests).toHaveLength(0)
  expect((await command('status')).pairingFailure.reason).toContain('设备名')
  const second = await send('/rc/pair/request', { token, fingerprint: state.node.fingerprint })
  const wrongFingerprint = await command('approve', { id: second.body.id, name: '远程设备', fingerprint: 'f'.repeat(32) })
  expect(wrongFingerprint.status).toBe(400)
  expect((await command('status')).pairingFailure.reason).toContain('指纹')
  const third = await send('/rc/pair/request', { token, fingerprint: state.node.fingerprint })
  expect((await command('approve', { id: third.body.id, name: '远程设备', fingerprint: state.node.fingerprint })).status).toBe(200)
  const claim = await send('/rc/pair/claim', { id: third.body.id, key: third.body.key })
  expect(claim.status).toBe(200); expect(claim.cookie).toContain('dsh_rc='); expect(claim.cookie).toContain('; Secure')
  expect((await command('status')).devices).toHaveLength(1)
  const cookie = claim.cookie.split(';')[0]!
  // The boot script handed to the paired browser carries this host's LAN fallback, so an offline
  // public connection can switch to the LAN entry without asking the user to rescan.
  const opened = await send('/rc/boot.js', undefined, { cookie }, 'GET')
  expect(opened.status).toBe(200); expect(opened.text).toContain('rc=lan'); expect(opened.text).toContain('lanFallback')
  // Workspace-file links from messages: served to the paired device, refused to an unpaired one.
  const raw = (path: string, headers: Record<string, string>) => new Promise<{ status: number; body: string; location: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: state.gatewayPort, path, method: 'GET', headers: { host: 'dsh.example.com', ...headers } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, location: String(res.headers.location ?? '') }))
    }); req.on('error', reject); req.end()
  })
  const preview = join(tmpdir(), `dsh-rc-preview-${Date.now()}.html`)
  writeFileSync(preview, '<p>preview-ok</p>')
  try {
    expect((await raw('/rc/workspace-file?p=' + encodeURIComponent(preview), {})).status).toBe(403)
    const redirected = await raw('/rc/workspace-file?p=' + encodeURIComponent(preview), { cookie })
    expect(redirected.status).toBe(303)
    const served = await raw(redirected.location, { origin: 'null' })
    expect(served.status).toBe(200); expect(served.body).toContain('preview-ok'); expect(served.body).toContain('<p>preview-ok</p>')
    expect((await raw('/rc/workspace-file?p=' + encodeURIComponent('C:/data/../secrets.txt'), { cookie })).status).toBe(400)
  } finally { rmSync(preview, { force: true }) }
}))

it('does not resurrect an entry after closing during an asynchronous listen', async () => withHost(async command => {
  const listen = Gateway.prototype.listen
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(Gateway.prototype, 'listen').mockImplementationOnce(async function (host, port) { await gate; return listen.call(this, host, port) })
  await command('preferences', { mode: 'lan' }); const starting = command('start')
  await vi.waitFor(async () => expect((await command('status')).busy).toBe(true))
  expect((await command('start')).status).toBe(400)
  await command('stop'); await new Promise(resolve => setTimeout(resolve, 100)); release(); await starting
  expect(await command('status')).toMatchObject({ enabled: false, busy: false, phase: 'off', gatewayPort: 0, links: [] })
}))

async function remoteClient(command: (action: string, fields?: Record<string, unknown>) => Promise<any>) {
  await command('preferences', { mode: 'lan' }); const state = await command('start')
  const base = `http://127.0.0.1:${state.gatewayPort}`
  const post = (path: string, data: unknown, cookie = '') => fetch(base + path, { method: 'POST', headers: { origin: base, cookie, 'content-type': 'application/json' }, body: JSON.stringify(data) })
  const request = await (await post('/rc/pair/request', { token: new URL(state.links[0].url).hash.slice(6) })).json()
  await approve(command, request.id)
  const claim = await post('/rc/pair/claim', { id: request.id, key: request.key })
  const cookie = claim.headers.get('set-cookie')!.split(';')[0]!
  return { state, base, post: (path: string, data: unknown) => post(path, data, cookie), manage: async (action: string, fields: Record<string, unknown> = {}) => { const response = await post(MANAGE_PATH, { action, ...fields }, cookie); return { status: response.status, ...await response.json() } } }
}

/** The computer-side confirmation: the same device name and the same fingerprint the page showed. */
async function approve(command: (action: string, fields?: Record<string, unknown>) => Promise<any>, id: string) {
  const state = await command('status')
  const pending = state.requests.find((row: { id: string }) => row.id === id)
  expect(pending).toBeDefined()
  const approved = await command('approve', { id, name: pending.name, fingerprint: state.node.fingerprint })
  expect(approved.status).toBe(200)
}

it('stores bounded boot diagnostics without credentials or client-controlled metadata', async () => withHost(async command => {
  const remote = await remoteClient(command)
  expect((await remote.post('/rc/boot-report', {
    time: 'forged', device: { id: 'forged' }, href: 'https://example.test/?token=secret#pair=secret',
    origin: remote.base, path: '/?token=secret#pair=secret', phase: 'ready', result: 'ready', durationMs: 123, mounted: true,
    errors: ['failed https://example.test/code.js?token=secret#secret cookie=secret'],
    resources: [{ origin: remote.base, path: '/plugins/code.js?token=secret', rev: 'abc123', result: 'loaded', durationMs: 12 }],
  })).status).toBe(204)
  const file = join(process.env.DSH_HOME!, 'dsh-remote-connect', 'default', 'boot-reports.jsonl')
  const line = readFileSync(file, 'utf8')
  expect(line).not.toContain('secret'); expect(line).not.toContain('forged')
  expect(JSON.parse(line)).toMatchObject({ origin: remote.base, path: '/', phase: 'ready', mounted: true, resources: [{ path: '/plugins/code.js', rev: 'abc123' }] })
}))

it('rejects an invalid LAN certificate before replacing a live public entry', async () => withHost(async command => {
  await command('preferences', { mode: 'public', publicUrl: 'https://dsh.example.com' })
  const before = await command('start')
  await command('preferences', { mode: 'lan' })
  expect((await command('switch')).status).toBe(400)
  const after = await command('status')
  expect(after).toMatchObject({ enabled: true, activeMode: 'public', links: before.links, qr: before.qr, lanTls: { error: expect.any(String) } })
}, { gatewayPort: 59396, lanTls: { hostname: 'lan.example.test', certFile: 'missing.pem', keyFile: 'missing.key' } }))

it('publishes a fixed HTTPS entry, secures pairing and reloads certificates only locally', async () => {
  const reserved = createServer()
  await new Promise<void>(resolve => reserved.listen(0, '127.0.0.1', resolve))
  const port = (reserved.address() as { port: number }).port
  await new Promise<void>(resolve => reserved.close(() => resolve()))
  const fixtures = join(import.meta.dirname, 'fixtures', 'lan-tls')
  const folder = mkdtempSync(join(tmpdir(), 'dsh-rc-reload-'))
  const certFile = join(folder, 'server.pem'), keyFile = join(folder, 'key.pem')
  writeFileSync(certFile, readFileSync(join(fixtures, 'server.pem'))); writeFileSync(keyFile, readFileSync(join(fixtures, 'key-1.pem')))
  try {
    await withHost(async command => {
      const state = await command('start'), origin = `https://lan.example.test:${port}`
      expect(state).toMatchObject({ enabled: true, activeMode: 'lan', gatewayPort: port, links: [{ base: origin }], lanTls: { origin, expiresAt: expect.any(Number) } })
      expect(JSON.stringify(state.lanTls)).not.toMatch(/certFile|keyFile|PRIVATE KEY/)
      const call = (path: string, data?: unknown, cookie = '') => new Promise<{ status: number; body: any; cookie: string }>((resolve, reject) => {
        const req = httpsRequest({ hostname: '127.0.0.1', servername: 'lan.example.test', port, path, method: data ? 'POST' : 'GET', ca: readFileSync(join(fixtures, 'server.pem')), headers: { host: new URL(origin).host, origin, cookie, 'content-type': 'application/json' } }, res => {
          let value = ''; res.setEncoding('utf8'); res.on('data', chunk => value += chunk); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: value ? JSON.parse(value) : {}, cookie: res.headers['set-cookie']?.[0] ?? '' }))
        }); req.on('error', reject); req.end(data ? JSON.stringify(data) : undefined)
      })
      const pending = await call('/rc/pair/request', { token: new URL(state.links[0].url).hash.slice(6) })
      await approve(command, pending.body.id)
      const claim = await call('/rc/pair/claim', { id: pending.body.id, key: pending.body.key })
      expect(claim.cookie).toContain('; Secure')
      expect((await call(MANAGE_PATH, { action: 'reloadLanCertificate' }, claim.cookie.split(';')[0])).status).toBe(400)
      expect((await command('reloadLanCertificate')).status).toBe(200)
      writeFileSync(certFile, readFileSync(join(fixtures, 'wrong-host.pem')))
      expect((await command('reloadLanCertificate')).status).toBe(400)
      expect((await command('status')).lanTls.error).toEqual(expect.any(String))
      expect((await call(MANAGE_PATH, { action: 'requests' }, claim.cookie.split(';')[0])).status).toBe(200)
    }, { gatewayPort: port, lanTls: { hostname: 'lan.example.test', certFile, keyFile } })
  } finally { rmSync(folder, { recursive: true, force: true }) }
})

it('acknowledges an authorized remote switch before terminating its old entry', async () => withHost(async command => {
  const remote = await remoteClient(command)
  expect((await remote.manage('approve', { id: 'anything' })).status).toBe(400)
  expect((await remote.manage('preferences', { publicUrl: 'https://dsh.example.com' })).status).toBe(400)
  await command('preferences', { publicUrl: 'https://dsh.example.com' })
  await remote.manage('preferences', { mode: 'public' })
  expect(await remote.manage('switch')).toMatchObject({ switching: true, mode: 'public', status: 200 })
  await vi.waitFor(async () => expect(await command('status')).toMatchObject({ activeMode: 'public', phase: 'ready' }))
  expect(await fetch(remote.base + '/').then(response => response.status, () => 0)).not.toBe(200)
  expect((await command('status')).devices).toHaveLength(1)
}))

it('cancels a remotely queued switch when the local owner closes the gateway', async () => withHost(async command => {
  const remote = await remoteClient(command); await command('preferences', { publicUrl: 'https://dsh.example.com' }); await remote.manage('preferences', { mode: 'public' })
  expect((await remote.manage('switch')).switching).toBe(true)
  await command('stop'); await new Promise(resolve => setTimeout(resolve, 150))
  expect(await command('status')).toMatchObject({ enabled: false, busy: false, phase: 'off', links: [] })
}))

it('rolls back a saved public domain when preference persistence fails', async () => withHost(async command => {
  await command('preferences', { mode: 'public', publicUrl: 'https://first.example.com' })
  const before = await command('start')
  await command('stop')
  const file = join(process.env.DSH_HOME!, 'dsh-remote-connect', 'default', 'preferences.json')
  rmSync(file); mkdirSync(file)
  expect((await command('preferences', { publicUrl: 'https://second.example.com' })).status).toBe(400)
  expect((await command('status')).publicUrl).toBe('https://first.example.com')
  expect(JSON.parse(readFileSync(join(process.env.DSH_HOME!, 'dsh-remote-connect', 'default', 'public-url.json'), 'utf8')).publicUrl).toBe('https://first.example.com')
  expect(before.publicUrl).toBe('https://first.example.com')
}))

it('rolls back unsaved preferences and preserves the live entry when atomic persistence fails', async () => withHost(async command => {
  await command('preferences', { mode: 'lan' }); const before = await command('start')
  const file = join(process.env.DSH_HOME!, 'dsh-remote-connect', 'default', 'preferences.json')
  rmSync(file); mkdirSync(file)
  expect((await command('preferences', { mode: 'public' })).status).toBe(400)
  const after = await command('status')
  expect(after).toMatchObject({ mode: 'lan', activeMode: 'lan', enabled: true, gatewayPort: before.gatewayPort })
  expect(after.qr).toBe(before.qr)
}))

it('cancels unfinished startup when the plugin unloads', async () => withHost(async (command, ctx) => {
  const listen = Gateway.prototype.listen
  let release!: () => void, opened = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(Gateway.prototype, 'listen').mockImplementationOnce(async function (host, port) { await gate; opened = await listen.call(this, host, port); return opened })
  await command('preferences', { mode: 'lan' }); const starting = command('start')
  await vi.waitFor(async () => expect((await command('status')).busy).toBe(true))
  ctx.registry.delete(Plugin); release(); await starting
  await expect(fetch(`http://127.0.0.1:${opened}/`)).rejects.toThrow()
}))
