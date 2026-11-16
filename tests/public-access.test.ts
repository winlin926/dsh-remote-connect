import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PublicAccess, PUBLIC_IDENTITY_MESSAGE, PUBLIC_TLS_MESSAGE, PUBLIC_UNREACHABLE_MESSAGE } from '../src/public-access.js'
import { normalizePublicUrl, readPublicUrl } from '../src/public-url-settings.js'
import { Gateway } from '../src/gateway.js'
import { PairingService } from '../src/pairing.js'

const HOST_ID = '5QKQY_VIKcY52sBuej3ozcSh4gUAwAYe0YENr18qsfA'
const FINGERPRINT = 'e5029063f54829c639dac06e7a3de8cd'
const IDENTITY = { hostId: HOST_ID, fingerprint: FINGERPRINT }
const node = (changes: Record<string, unknown> = {}) => ({ protocol: 1, kind: 'gateway', name: 'DeepSeek Harness', version: '0.5.1', capabilities: ['pairing', 'official-ui'], hostId: HOST_ID, fingerprint: FINGERPRINT, ...changes })

const folders: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })
async function folder() { const value = await mkdtemp(join(tmpdir(), 'dsh-rc-public-')); folders.push(value); return value }
async function configured(options: { now?: () => number } = {}) {
  const root = await folder()
  const value = new PublicAccess({ storage: join(root, 'new'), legacyStorage: join(root, 'legacy'), certificateDir: join(root, 'cert'), proxy: async () => undefined, identity: IDENTITY, ...options })
  await value.saveDomain('https://dsh.example.com')
  return value
}

describe('fixed public URL', () => {
  it('normalizes HTTPS origins and rejects paths and private targets', () => {
    expect(normalizePublicUrl(' https://Dsh.Example.Com/ ')).toBe('https://dsh.example.com')
    for (const value of ['http://dsh.example.com', 'https://dsh.example.com/path', 'https://127.0.0.1', 'https://192.168.1.2', 'https://user:secret@dsh.example.com', 'https://localhost']) expect(() => normalizePublicUrl(value)).toThrow()
  })
  it('migrates the existing roam domain without rewriting the legacy file', async () => {
    const root = await folder(), storage = join(root, 'new'), legacyStorage = join(root, 'legacy')
    await mkdir(legacyStorage, { recursive: true }); await writeFile(join(legacyStorage, 'settings.json'), JSON.stringify({ publicUrl: 'https://dsh.example.com/' }))
    const value = new PublicAccess({ storage, legacyStorage, certificateDir: join(root, 'certificates'), proxy: async () => undefined, identity: IDENTITY })
    await value.migrate()
    expect(value.domain).toBe('https://dsh.example.com')
    expect(readPublicUrl(join(storage, 'public-url.json'))).toBe('https://dsh.example.com')
  })
})

describe('public node probe', () => {
  it('classifies an unreachable tunnel, a foreign node and a certificate failure', async () => {
    const value = await configured()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    expect(await value.checkDomain()).toMatchObject({ reachable: false, status: null, failure: 'unreachable', error: PUBLIC_UNREACHABLE_MESSAGE })
    // A tunnel error page or a wrong origin answers with an HTTP error instead of the node document.
    for (const answer of [new Response('Bad gateway', { status: 502 }), new Response('not json', { status: 200 })]) {
      vi.stubGlobal('fetch', vi.fn(async () => answer))
      expect(await value.checkDomain()).toMatchObject({ reachable: false, failure: 'unreachable', error: PUBLIC_UNREACHABLE_MESSAGE })
    }
    // A document that answers 200 but is not a node document at all: something else lives at this domain.
    for (const body of [{ service: 'another-service' }, node({ kind: 'service' }), node({ protocol: 2 })]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
      expect(await value.checkDomain()).toMatchObject({ reachable: false, failure: 'identity', error: PUBLIC_IDENTITY_MESSAGE })
    }
    // A valid node document that is not this computer: another Host, another protocol.
    for (const changes of [{ hostId: 'A'.repeat(43) }, { fingerprint: '0'.repeat(32) }]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(node(changes))))
      expect(await value.checkDomain()).toMatchObject({ reachable: false, status: 200, failure: 'identity', error: PUBLIC_IDENTITY_MESSAGE })
    }
    const tls = Object.assign(new Error('fetch failed'), { cause: new Error('UNABLE_TO_VERIFY_LEAF_SIGNATURE') })
    vi.stubGlobal('fetch', vi.fn(async () => { throw tls }))
    expect(await value.checkDomain()).toMatchObject({ reachable: false, status: null, failure: 'tls', error: PUBLIC_TLS_MESSAGE })
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { urls.push(String(url)); return Response.json(node()) }))
    expect(await value.checkDomain()).toMatchObject({ reachable: true, status: 200, failure: null, error: null })
    expect(urls).toEqual(['https://dsh.example.com/.well-known/dsh-remote'])
  })
  it('probes the node document once with one timeout and never stores a stale result', async () => {
    const value = await configured()
    const signals: AbortSignal[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      signals.push(init.signal as AbortSignal)
      await value.saveDomain('https://new.example.com')
      throw new TypeError('fetch failed')
    }))
    expect(await value.checkDomain()).toMatchObject({ reachable: false, failure: 'unreachable', error: PUBLIC_UNREACHABLE_MESSAGE })
    expect(signals).toHaveLength(1)
    expect(value.lastCheck).toBeUndefined()
  })
})

describe('fixed-domain gateway admission', () => {
  it('confirms the node on both ends before pairing and serves only ACME token files', async () => {
    const root = await folder(), upstream = createServer((_req, res) => res.end('private'))
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as { port: number }).port
    const value = new PublicAccess({ storage: join(root, 'new'), legacyStorage: join(root, 'legacy'), certificateDir: join(root, 'cert'), proxy: async () => undefined, identity: IDENTITY })
    await value.saveDomain('https://dsh.example.com')
    const pairing = new PairingService({ file: join(root, 'devices.json') })
    const discovery = { protocol: 1 as const, kind: 'gateway' as const, name: 'DeepSeek Harness', version: '0.5.1', capabilities: ['pairing' as const, 'official-ui' as const], hostId: HOST_ID, fingerprint: FINGERPRINT }
    const gateway = new Gateway({ pairing, upstreamPort, upstreamCookie: () => 'host=1', manage: async () => ({}), public: () => value, discovery, boot: () => '' })
    await gateway.listen('127.0.0.1')
    const host = 'dsh.example.com'
    const origin = { origin: 'https://dsh.example.com', 'content-type': 'application/json' }
    const call = (path: string, method = 'GET', headers: Record<string, string> = {}, data?: unknown) => new Promise<{ status: number; body: string; cookie: string; header: (name: string) => string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: gateway.port, path, method, headers: { host, ...headers } }, res => {
        let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode ?? 0, body, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] ?? '', header: name => String(res.headers[name] ?? '') }))
      }); req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data))
    })
    try {
      const page = await call('/pair')
      expect(page.status).toBe(200)
      expect(page.body).toContain('确认是本机'); expect(page.body).toContain('E502-9063-F548-29C6-39DA-C06E-7A3D-E8CD'); expect(page.body).toContain('隧道网关'); expect(page.body).not.toContain('6 位连接密码')
      // A browser that did not confirm this host's fingerprint cannot open a pairing ticket.
      expect((await call('/rc/pair/request', 'POST', origin, {})).status).toBe(403)
      expect(JSON.parse((await call('/rc/pair/request', 'POST', origin, {})).body)).toMatchObject({ code: 'fingerprint_mismatch' })
      expect((await call('/api/echo', 'GET', { host: 'attacker.example' })).status).toBe(403)
      await mkdir(value.challengeDir, { recursive: true }); await writeFile(join(value.challengeDir, 'valid-token'), 'proof')
      expect((await call('/.well-known/acme-challenge/valid-token')).body).toBe('proof')
      expect((await call('/.well-known/acme-challenge/..%2Fsecret')).status).toBe(403)
      expect(JSON.parse((await call('/rc/health')).body)).toEqual({ ok: true, service: 'dsh-remote-connect', instanceId: value.instanceId })
      const document = await call('/.well-known/dsh-remote')
      expect(document.status).toBe(200); expect(JSON.parse(document.body)).toEqual(discovery)
      expect(document.header('cache-control')).toBe('no-store')
      // The password endpoints are gone: without a device cookie they are just unpaired requests.
      for (const path of ['/rc/pair/verify', '/rc/pair/direct']) expect((await call(path, 'POST', origin, { pin: '051109' })).status).toBe(403)
      const qr = pairing.issue()
      const requested = await call('/rc/pair/request', 'POST', origin, { token: qr.token, fingerprint: FINGERPRINT })
      expect(requested.status).toBe(200)
      const ticket = JSON.parse(requested.body)
      expect(pairing.list()).toHaveLength(0)
      pairing.approve(ticket.id)
      const approved = await call('/rc/pair/claim', 'POST', origin, { id: ticket.id, key: ticket.key })
      expect(approved.status).toBe(200); expect(approved.cookie).toContain('dsh_rc=')
      expect((await call('/rc/pair/claim', 'POST', origin, { id: ticket.id, key: ticket.key })).cookie).toBe(approved.cookie)
      const device = approved.cookie
      expect((await call('/api/echo', 'GET', { cookie: device })).status).toBe(200)
      const resumed = await call('/pair', 'GET', { cookie: device })
      expect(resumed.status).toBe(200); expect(resumed.body).not.toContain('if(true)return')
      pairing.revokeAll()
      expect((await call('/api/echo', 'GET', { cookie: device })).status).toBe(403)
    } finally {
      await gateway.close()
      await new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()) })
    }
  })
})
