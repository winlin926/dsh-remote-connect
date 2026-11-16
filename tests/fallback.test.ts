import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Gateway } from '../src/gateway.js'
import { PairingService } from '../src/pairing.js'
import { PublicAccess } from '../src/public-access.js'
import type { PublicNodeDiscovery } from '../src/public-node.js'

const HOST_ID = '5QKQY_VIKcY52sBuej3ozcSh4gUAwAYe0YENr18qsfA'
const OTHER_HOST_ID = 'A'.repeat(43)
const FINGERPRINT = 'e5029063f54829c639dac06e7a3de8cd'
const OTHER_FINGERPRINT = '0'.repeat(32)
const node = (hostId: string, fingerprint: string): PublicNodeDiscovery => ({ protocol: 1, kind: 'gateway', name: 'DeepSeek Harness', version: '0.5.1', capabilities: ['pairing', 'official-ui'], hostId, fingerprint })

const folders: string[] = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })

class Lan {
  readonly gateway: Gateway
  port = 0
  constructor(readonly discovery: PublicNodeDiscovery, readonly root: string) {
    this.gateway = new Gateway({
      pairing: new PairingService({ file: join(root, 'devices-lan.json') }),
      upstreamPort: 1, upstreamCookie: () => '', manage: async () => ({}), discovery, boot: () => '',
    })
  }
  async start() { this.port = await this.gateway.listen('127.0.0.1'); return this }
  get url() { return `http://127.0.0.1:${this.port}` }
}

interface PublicGateway {
  gateway: Gateway
  port: number
  credential: string
}

async function publicGateway(root: string, lan: string | undefined, discovery: PublicNodeDiscovery, identity: { hostId: string; fingerprint: string }): Promise<PublicGateway> {
  const access = new PublicAccess({ storage: join(root, 'new'), legacyStorage: join(root, 'legacy'), certificateDir: join(root, 'cert'), proxy: async () => undefined, identity })
  await access.saveDomain('https://dsh.example.com')
  const pairing = new PairingService({ file: join(root, 'devices-public.json') })
  const ticket = pairing.issue(), claim = pairing.request(ticket.token, '远程设备')
  pairing.approve(claim.id)
  const credential = pairing.claim(claim.id, claim.key).credential!
  const upstream = createServer((_req, res) => res.end('private'))
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const gateway = new Gateway({
    pairing, upstreamPort: (upstream.address() as { port: number }).port, upstreamCookie: () => '', manage: async () => ({}),
    public: () => access, lanFallback: () => lan, discovery, boot: () => '',
  })
  const port = await gateway.listen('127.0.0.1')
  goto.push(async () => { await gateway.close(); await new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()) }) })
  return { gateway, port, credential }
}
const goto: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of goto.splice(0)) await stop() })

const call = (port: number, path: string, options: { method?: string; headers?: Record<string, string>; data?: unknown } = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const req = request({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: 'dsh.example.com', origin: 'https://dsh.example.com', ...options.headers } }, res => {
    let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
  })
  req.on('error', reject); req.end(options.data === undefined ? undefined : JSON.stringify(options.data))
})
const fallback = (port: number, credential: string) => call(port, '/rc/fallback', { method: 'POST', headers: { 'content-type': 'application/json', cookie: `dsh_rc=${credential}` }, data: {} })

describe('same-host LAN fallback', () => {
  it('answers for the same Host and hands back the LAN entry of this computer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rc-fallback-')); folders.push(root)
    const lan = await new Lan(node(HOST_ID, FINGERPRINT), root).start()
    const value = await publicGateway(root, lan.url, node(HOST_ID, FINGERPRINT), { hostId: HOST_ID, fingerprint: FINGERPRINT })
    try {
      // The public entry exposes the same discovery document as the LAN entry.
      expect(JSON.parse((await call(value.port, '/.well-known/dsh-remote')).body)).toEqual(node(HOST_ID, FINGERPRINT))
      const answer = await fallback(value.port, value.credential)
      expect(answer.status).toBe(200)
      expect(JSON.parse(answer.body)).toEqual({ sameHost: true, url: lan.url, hostId: HOST_ID, fingerprint: FINGERPRINT })
    } finally { await lan.gateway.close() }
  })

  it('refuses when the LAN entry belongs to another Host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rc-fallback-')); folders.push(root)
    const lan = await new Lan(node(OTHER_HOST_ID, OTHER_FINGERPRINT), root).start()
    const value = await publicGateway(root, lan.url, node(HOST_ID, FINGERPRINT), { hostId: HOST_ID, fingerprint: FINGERPRINT })
    try {
      const answer = await fallback(value.port, value.credential)
      expect(JSON.parse(answer.body)).toEqual({ sameHost: false, reason: 'identity' })
    } finally { await lan.gateway.close() }
  })

  it('refuses when the browser has no LAN authorization, and when no LAN entry is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rc-fallback-')); folders.push(root)
    const lan = await new Lan(node(HOST_ID, FINGERPRINT), root).start()
    const value = await publicGateway(root, lan.url, node(HOST_ID, FINGERPRINT), { hostId: HOST_ID, fingerprint: FINGERPRINT })
    const noLan = await publicGateway(root, undefined, node(HOST_ID, FINGERPRINT), { hostId: HOST_ID, fingerprint: FINGERPRINT })
    try {
      const anonymous = await call(value.port, '/rc/fallback', { method: 'POST', headers: { 'content-type': 'application/json' }, data: {} })
      expect(anonymous.status).toBe(403); expect(JSON.parse(anonymous.body)).toMatchObject({ code: 'unpaired' })
      expect(JSON.parse((await fallback(noLan.port, noLan.credential)).body)).toEqual({ sameHost: false, reason: 'no-lan-entry' })
    } finally { await lan.gateway.close() }
  })
})
