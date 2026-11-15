import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, request as httpRequest } from 'node:http'
import { request } from 'node:https'
import { connect as connectTcp } from 'node:net'
import { connect as connectTls } from 'node:tls'
import { once } from 'node:events'
import type { IncomingHttpHeaders } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { Gateway } from '../src/gateway.js'
import { PairingService } from '../src/pairing.js'
import { readLanTls } from '../src/lan-tls.js'
import { bootScript } from '../src/boot.js'

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/lan-tls/${name}.pem`, import.meta.url))
const ca = [readFileSync(fixture('server')), readFileSync(fixture('renewed'))]
const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

async function tlsFixture() {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-rc-tls-'))
  cleanup.push(() => rmSync(folder, { recursive: true, force: true }))
  const upstream = createServer((req, res) => {
    if (req.url === '/plugins/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: hello\n\n')
      return
    }
    res.setHeader('content-type', 'text/javascript'); res.setHeader('cache-control', 'public, max-age=31536000, immutable')
    res.end(JSON.stringify({ cookie: req.headers.cookie, origin: req.headers.origin }))
  })
  const wss = new WebSocketServer({ server: upstream })
  wss.on('connection', ws => ws.on('message', (data, binary) => ws.send(data, { binary })))
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { for (const ws of wss.clients) ws.terminate(); wss.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
  const port = await availablePort()
  const material = await readLanTls({ hostname: 'lan.example.test', certFile: fixture('server'), keyFile: fixture('key-1') }, port)
  let gateway: Gateway
  const pairing = new PairingService({ file: join(folder, 'devices.json'), onRevoke: id => gateway.revoke(id) })
  gateway = new Gateway({ pairing, upstreamPort: (upstream.address() as { port: number }).port, upstreamCookie: () => 'host-private=secret', manage: async () => ({}), index: async () => '<head><meta name="viewport" content="width=device-width"></head><body><div id="root"></div></body>', boot: bootScript, lanTls: material, addresses: () => ['192.168.1.23'] })
  cleanup.push(() => gateway.close())
  await gateway.listen('127.0.0.1', port)
  const credential = pairing.pairDirectly('Test device'), cookie = `dsh_rc=${credential}`, authority = new URL(material.origin).host
  const call = (path: string, headers: Record<string, string> = {}, body?: unknown) => new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', servername: 'lan.example.test', port, ca, agent: false, path, method: body === undefined ? 'GET' : 'POST', headers: { host: authority, ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk }); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text })); res.on('error', reject)
    })
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  const socket = (path: string, origin = material.origin) => new WebSocket(`wss://127.0.0.1:${port}${path}`, { servername: 'lan.example.test', ca, headers: { host: authority, origin, cookie } })
  return { gateway, pairing, material, port, authority, cookie, call, socket }
}

it('serves LAN HTTPS only at the canonical Host with a Secure device cookie', async () => {
  const f = await tlsFixture()
  const response = await f.call('/api/asset', { cookie: f.cookie, origin: f.material.origin })
  expect(response.status).toBe(200)
  expect(response.headers['set-cookie']?.[0]).toContain('; Secure')
  expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable')
  expect(JSON.parse(response.body)).toEqual({ cookie: 'host-private=secret', origin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/) })
  for (const host of [`127.0.0.1:${f.port}`, `localhost:${f.port}`, `192.168.1.23:${f.port}`, 'evil.example']) {
    f.gateway.allowAuthority(host)
    expect((await f.call('/api/asset', { host, cookie: f.cookie })).status).toBe(403)
  }
  for (const origin of [`http://${f.authority}`, 'https://lan.example.test:1', 'https://evil.example']) expect((await f.call('/api/asset', { cookie: f.cookie, origin })).status).toBe(403)
  expect((await f.call('/api/asset')).status).toBe(403)
  expect((await f.call('/pair')).body).toContain('在电脑上确认')
  expect((await f.call('/rc/pair/direct', { origin: f.material.origin }, { pin: '123456' })).status).toBe(403)
  await expect(new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: f.port, path: '/pair', headers: { host: f.authority } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject); req.end()
  })).rejects.toMatchObject({ code: 'ECONNRESET' })
})

it('issues a Secure cookie after QR approval without enabling the public password gate', async () => {
  const f = await tlsFixture(), token = f.pairing.issue().token, headers = { origin: f.material.origin }
  const requested = await f.call('/rc/pair/request', headers, { token })
  expect(requested.status).toBe(200)
  const claim = JSON.parse(requested.body); f.pairing.approve(claim.id)
  const approved = await f.call('/rc/pair/claim', headers, { id: claim.id, key: claim.key })
  expect(approved.status).toBe(200)
  expect(approved.headers['set-cookie']?.[0]).toContain('; Secure')
  expect(JSON.parse(approved.body).state).toBe('approved')
})

it('carries Host WebSockets and SSE over authenticated WSS and revokes both', async () => {
  const f = await tlsFixture(), mux = f.socket('/api/remote.mux')
  await once(mux, 'open')
  mux.send('hello'); expect(String((await once(mux, 'message'))[0])).toBe('hello')
  const sse = f.socket('/rc/sse?path=%2Fplugins%2Fevents'), frames: Array<{ type: string; data?: string }> = []
  const received = new Promise<void>(resolve => sse.on('message', data => { const frame = JSON.parse(String(data)); frames.push(frame); if (frame.data?.includes('hello')) resolve() }))
  await received
  expect(frames.some(frame => frame.type === 'ready')).toBe(true)
  const refused = f.socket('/api/remote.mux', `http://${f.authority}`)
  refused.on('error', () => {})
  const [, response] = await once(refused, 'unexpected-response')
  expect(response.statusCode).toBe(403); refused.terminate()
  const closed = Promise.all([once(mux, 'close'), once(sse, 'close')]); f.pairing.revokeAll(); await closed
})

it('reloads a valid certificate atomically and keeps the last good context on failure', async () => {
  const f = await tlsFixture()
  const mux = f.socket('/api/remote.mux'); await once(mux, 'open')
  const serial = () => new Promise<string>((resolve, reject) => {
    const socket = connectTls({ host: '127.0.0.1', port: f.port, servername: 'lan.example.test', ca }, () => { const value = socket.getPeerCertificate().serialNumber; socket.end(); resolve(value) })
    socket.on('error', reject)
  })
  expect(await serial()).toBe('01')
  const renewed = await readLanTls({ hostname: 'lan.example.test', certFile: fixture('renewed'), keyFile: fixture('key-2') }, f.port)
  f.gateway.reloadLanCertificate(renewed)
  expect(await serial()).toBe('02')
  expect(() => f.gateway.reloadLanCertificate({ ...renewed, origin: 'https://other.example.test' })).toThrow(/地址/)
  expect(() => f.gateway.reloadLanCertificate({ ...renewed, key: f.material.key })).toThrow()
  expect(await serial()).toBe('02')
  expect((await f.call('/api/asset', { cookie: f.cookie })).status).toBe(200)
  mux.send('still connected'); expect(String((await once(mux, 'message'))[0])).toBe('still connected')
  mux.close(); await once(mux, 'close')
})

it('closes connections still waiting for their TLS handshake', async () => {
  const f = await tlsFixture(), socket = connectTcp({ host: '127.0.0.1', port: f.port })
  await once(socket, 'connect')
  const closed = once(socket, 'close')
  await f.gateway.close(); await closed
  expect(socket.destroyed).toBe(true)
})

it('refuses an unfixed or mismatched TLS listener port', async () => {
  const f = await tlsFixture(); await f.gateway.close()
  await expect(f.gateway.listen('127.0.0.1')).rejects.toThrow(/端口/)
  await expect(f.gateway.listen('127.0.0.1', f.port === 65535 ? 65534 : f.port + 1)).rejects.toThrow(/端口/)
})
