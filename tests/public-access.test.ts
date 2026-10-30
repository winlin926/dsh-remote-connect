import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PublicAccess } from '../src/public-access.js'
import { normalizePublicUrl, readPublicUrl } from '../src/public-url-settings.js'
import { Gateway } from '../src/gateway.js'
import { PairingService } from '../src/pairing.js'

const folders: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })
async function folder() { const value = await mkdtemp(join(tmpdir(), 'dsh-rc-public-')); folders.push(value); return value }

describe('fixed public URL', () => {
  it('normalizes HTTPS origins and rejects paths and private targets', () => {
    expect(normalizePublicUrl(' https://Dsh.Example.Com/ ')).toBe('https://dsh.example.com')
    for (const value of ['http://dsh.example.com', 'https://dsh.example.com/path', 'https://127.0.0.1', 'https://192.168.1.2', 'https://user:secret@dsh.example.com', 'https://localhost']) expect(() => normalizePublicUrl(value)).toThrow()
  })
  it('migrates the existing roam domain without rewriting the legacy file', async () => {
    const root = await folder(), storage = join(root, 'new'), legacyStorage = join(root, 'legacy')
    await mkdir(legacyStorage, { recursive: true }); await writeFile(join(legacyStorage, 'settings.json'), JSON.stringify({ publicUrl: 'https://dsh.example.com/' }))
    const access = new PublicAccess({ storage, legacyStorage, certificateDir: join(root, 'certificates'), proxy: async () => undefined })
    await access.migrate()
    expect(access.domain).toBe('https://dsh.example.com')
    expect(readPublicUrl(join(storage, 'public-url.json'))).toBe('https://dsh.example.com')
    expect(access.password(true)).toMatch(/^\d{6}$/)
    expect(access.password(false)).toBeUndefined()
  })
})

describe('connection password and public probe', () => {
  it('persists a fixed PIN, restores random PINs and limits repeated failures', async () => {
    const root = await folder(); let now = 1_000_000
    const access = new PublicAccess({ storage: join(root, 'new'), legacyStorage: join(root, 'legacy'), certificateDir: join(root, 'cert'), proxy: async () => undefined, now: () => now })
    await access.saveDomain('https://dsh.example.com')
    expect(await access.setPin('051109')).toBe(true)
    expect(access.verifyPin('wrong', 'phone')).toEqual({ ok: false })
    expect(access.verifyPin('051109', 'phone')).toEqual({ ok: true })
    for (let i = 0; i < 5; i++) access.verifyPin('wrong', 'other')
    expect(access.verifyPin('051109', 'other').retryAfter).toBeGreaterThan(0)
    expect(await access.setPin('')).toBe(true)
    expect(access.fixedPin).toBe(false)
    now += 10 * 60_000 + 1
    expect(access.verifyPin(access.password(true)!, 'other')).toEqual({ ok: true })
  })
  it('requires the current gateway identity instead of accepting any reachable website', async () => {
    const root = await folder(), access = new PublicAccess({ storage: join(root, 'new'), legacyStorage: join(root, 'legacy'), certificateDir: join(root, 'cert'), proxy: async () => undefined })
    await access.saveDomain('https://dsh.example.com')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ service: 'another-service' })))
    expect((await access.checkDomain()).reachable).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ service: 'dsh-remote-connect' })))
    expect((await access.checkDomain()).reachable).toBe(true)
  })
})

describe('fixed-domain gateway admission', () => {
  it('requires PIN before pairing, keeps local approval, and serves only ACME token files', async () => {
    const root = await folder(), upstream = createServer((_req, res) => res.end('private'))
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as { port: number }).port
    const access = new PublicAccess({ storage: join(root, 'new'), legacyStorage: join(root, 'legacy'), certificateDir: join(root, 'cert'), proxy: async () => undefined })
    await access.saveDomain('https://dsh.example.com'); await access.setPin('051109')
    const pairing = new PairingService({ file: join(root, 'devices.json') })
    const gateway = new Gateway({ pairing, upstreamPort, upstreamCookie: () => 'host=1', manage: async () => ({}), public: () => access })
    await gateway.listen('127.0.0.1')
    const host = 'dsh.example.com'
    const call = (path: string, method = 'GET', headers: Record<string, string> = {}, data?: unknown) => new Promise<{ status: number; body: string; cookie: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: gateway.port, path, method, headers: { host, ...headers } }, res => {
        let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode ?? 0, body, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] ?? '' }))
      }); req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data))
    })
    const origin = { origin: 'https://dsh.example.com', 'content-type': 'application/json' }
    try {
      const page = await call('/pair')
      expect(page.status).toBe(200); expect(page.body).toContain('6 位连接密码')
      expect((await call('/rc/pair/request', 'POST', origin, {})).status).toBe(403)
      expect((await call('/api/echo', 'GET', { host: 'attacker.example' })).status).toBe(403)
      await mkdir(access.challengeDir, { recursive: true }); await writeFile(join(access.challengeDir, 'valid-token'), 'proof')
      expect((await call('/.well-known/acme-challenge/valid-token')).body).toBe('proof')
      expect((await call('/.well-known/acme-challenge/..%2Fsecret')).status).toBe(403)
      expect((await call('/rc/health')).body).toContain('dsh-remote-connect')
      expect((await call('/rc/pair/verify', 'POST', origin, { pin: 'wrong' })).status).toBe(401)
      const verify = await call('/rc/pair/verify', 'POST', origin, { pin: '051109' })
      expect(verify.status).toBe(200)
      const entry = verify.cookie
      const resumed = await call('/pair', 'GET', { cookie: entry })
      expect(resumed.body).not.toContain('if(true)return')
      expect(resumed.body).toContain('正在发送配对请求')
      const qr = pairing.issue()
      const requested = await call('/rc/pair/request', 'POST', { ...origin, cookie: entry }, { token: qr.token })
      const claim = JSON.parse(requested.body)
      expect(requested.status).toBe(200); expect(pairing.list()).toHaveLength(0)
      pairing.approve(claim.id)
      const approved = await call('/rc/pair/claim', 'POST', { ...origin, cookie: entry }, { id: claim.id, key: claim.key })
      expect(approved.status).toBe(200)
      const device = approved.cookie
      expect((await call('/api/echo', 'GET', { cookie: device })).status).toBe(200)
      gateway.revokeEntries()
      const returning = await call('/pair', 'GET', { cookie: device })
      expect(returning.body).not.toContain('if(true)return')
      pairing.revokeAll()
      expect((await call('/api/echo', 'GET', { cookie: device })).status).toBe(403)
    } finally {
      await gateway.close()
      await new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()) })
    }
  })
})
