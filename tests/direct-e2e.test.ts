import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RTCPeerConnection } from 'werift'
import { WebSocket, WebSocketServer } from 'ws'
import { Gateway } from '../src/gateway.js'
import { PairingService } from '../src/pairing.js'
import { bootScript } from '../src/boot.js'
import { DirectHost } from '../src/direct/peer.js'
import { remoteDirect } from '../src/boot-direct.js'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

/** The phone end of the loop: the shipping boot client, over a real WebRTC channel. */
async function scene(keepAliveMs?: number) {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-rc-e2e-')); cleanup.push(() => rmSync(folder, { recursive: true, force: true }))
  const seen: string[] = []
  const upstream = createServer((req, res) => { seen.push(req.url ?? ''); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ path: req.url })) })
  const webSockets = new WebSocketServer({ noServer: true })
  upstream.on('upgrade', (req, socket, head) => {
    if (req.url !== '/api/socket') { socket.destroy(); return }
    webSockets.handleUpgrade(req, socket, head, client => {
      client.on('message', (data, binary) => client.send(data, { binary }))
    })
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { webSockets.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
  const pairing = new PairingService({ file: join(folder, 'devices.json') })
  const claim = pairing.request(pairing.issue().token, 'Pixel'); pairing.approve(claim.id)
  const credential = pairing.claim(claim.id, claim.key).credential!
  const host = new DirectHost({ port: () => gateway.port, ...(keepAliveMs === undefined ? {} : { keepAliveMs }) })
  cleanup.push(() => host.close())
  let gateway: Gateway
  gateway = new Gateway({
    pairing, upstreamPort: (upstream.address() as { port: number }).port, upstreamCookie: () => 'host-private=secret',
    manage: async () => ({}), index: async () => '<!doctype html><title>Host</title>', boot: () => bootScript(),
    direct: { offer: (deviceId, sdp) => host.offer(deviceId, sdp), resolve: mark => host.mark(mark), closeDevice: id => host.closeDevice(id), preference: () => 'lan' },
  })
  await gateway.listen('127.0.0.1'); cleanup.push(() => gateway.close())
  const origin = 'http://127.0.0.1:' + gateway.port
  ;(globalThis as Record<string, unknown>).RTCPeerConnection = RTCPeerConnection as never
  const link = remoteDirect({
    signalPath: '/rc/direct/signal',
    fetch: (path: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const payload = String(init?.body ?? '')
      const request = httpRequest({ host: '127.0.0.1', port: gateway.port, method: init?.method ?? 'POST', path: new URL(path, origin).pathname,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), cookie: 'dsh_rc=' + credential, origin, host: '127.0.0.1:' + gateway.port } },
      response => {
        let text = ''; response.setEncoding('utf8')
        response.on('data', chunk => { text += chunk })
        response.on('end', () => resolve(new Response(response.statusCode === 204 ? null : text, { status: response.statusCode, headers: { 'content-type': 'application/json' } })))
      })
      request.on('error', reject); request.end(payload)
    }),
    setTimeout: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as never,
    clearTimeout: ((handle: never) => clearTimeout(handle)) as never,
    setInterval: ((fn: () => void, ms: number) => setInterval(fn, ms)) as never,
    clearInterval: ((handle: never) => clearInterval(handle)) as never,
    baseUrl: () => origin + '/',
    preference: () => 'lan',
  })
  cleanup.push(() => link.stop())
  return { link, host, gateway, seen, credential }
}

const until = async (predicate: () => boolean, timeoutMs = 20_000): Promise<void> => {
  const started = Date.now()
  while (!predicate()) { if (Date.now() - started > timeoutMs) throw new Error('等待直连线路超时。'); await new Promise(resolve => setTimeout(resolve, 50)) }
}

describe('direct line end to end', () => {
  it('carries a real Host request over the channel the phone opened', async () => {
    const s = await scene()
    await s.link.start()
    await until(() => s.link.ready)
    expect(s.host.state().filter(channel => channel.connected)).toHaveLength(1)
    const response = await s.link.fetch('/api/hello', { headers: { accept: 'application/json' } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ path: '/api/hello' })
    // The request reached the Host through the loopback bridge, counted on the direct line.
    expect(s.seen).toContain('/api/hello')
    expect(s.host.state()[0]!.stats.requests).toBe(1)
  }, 40_000)

  it('carries standards-compliant WebSocket messages and browser events over the channel', async () => {
    const s = await scene()
    await s.link.start()
    await until(() => s.link.ready)
    const socket = s.link.socket('ws://127.0.0.1:' + s.gateway.port + '/api/socket', ['echo.v1']) as WebSocket
    const message = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket echo timed out')), 5000)
      socket.addEventListener('open', () => {
        expect(socket.protocol).toBe('echo.v1')
        socket.send('direct channel message '.repeat(1200))
      }, { once: true })
      socket.addEventListener('message', event => { clearTimeout(timeout); resolve(event.data) }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('WebSocket connection failed')) }, { once: true })
    })
    expect(await message).toBe('direct channel message '.repeat(1200))
    socket.close()
    expect(s.host.state()[0]!.stats.sockets).toBe(1)
  }, 40_000)

  it('resets the Host keepalive only after receiving its matching pong', async () => {
    const s = await scene(80)
    await s.link.start()
    await until(() => s.link.ready)
    const initial = s.host.state().find(item => item.connected)?.sessionId
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(s.host.state().find(item => item.connected)?.sessionId).toBe(initial)
  }, 40_000)

  it('refuses a direct channel for a device that was just revoked', async () => {
    const s = await scene()
    await s.link.start()
    await until(() => s.link.ready)
    s.gateway.revoke(s.host.state()[0]!.deviceId)
    await until(() => s.host.state().length === 0, 5_000)
    expect(s.host.state()).toHaveLength(0)
  }, 40_000)
})
