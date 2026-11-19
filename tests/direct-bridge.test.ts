import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Gateway } from '../src/gateway.js'
import { PairingService } from '../src/pairing.js'
import { bootScript } from '../src/boot.js'
import { DirectBridge } from '../src/direct/bridge.js'
import { controlPayload, decodeDirectFrame, encodeDirectFrame, type DirectFrame } from '../src/direct/protocol.js'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

/** One fake DataChannel: frames delivered to the bridge, and everything the bridge sends back. */
function channel() {
  const out: DirectFrame[] = []
  let deliver: ((data: Uint8Array) => void) | undefined
  return {
    out,
    transport: { send: (data: Uint8Array) => { out.push(decodeDirectFrame(data)) }, close: () => {} },
    wire: (handle: { handle: (data: Uint8Array) => void }) => { deliver = handle.handle },
    send: (frame: DirectFrame) => { if (!deliver) throw new Error('channel not attached'); deliver(encodeDirectFrame(frame)) },
    async until(predicate: (frames: DirectFrame[]) => boolean, timeoutMs = 4000) {
      const started = Date.now()
      while (!predicate(out)) {
        if (Date.now() - started > timeoutMs) throw new Error('等待直连帧超时：' + JSON.stringify(out.map(frame => frame.t)))
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      return out
    },
  }
}

async function fixture(mark = 'mark-1') {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-rc-direct-')); cleanup.push(() => rmSync(folder, { recursive: true, force: true }))
  const seen: Array<{ path: string; cookie?: string; body: number }> = []
  const pairing = new PairingService({ file: join(folder, 'devices.json') })
  const claim = pairing.request(pairing.issue().token, 'Android'); pairing.approve(claim.id)
  const credential = pairing.claim(claim.id, claim.key).credential!
  const deviceId = pairing.list()[0]!.id
  const upstream = createServer((req, res) => {
    let size = 0
    req.on('data', chunk => { size += chunk.length })
    req.on('end', () => {
      seen.push({ path: req.url ?? '', cookie: req.headers.cookie, body: size })
      if (req.url === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('id: 1\ndata: 第一条\n\n')
        setTimeout(() => { res.write('id: 2\ndata: 第二条\n\n'); res.end() }, 30)
        return
      }
      res.setHeader('set-cookie', 'host-secret=never')
      res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie ?? null, size }))
    })
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
  const upstreamPort = (upstream.address() as { port: number }).port
  let gateway: Gateway
  gateway = new Gateway({
    pairing, upstreamPort, upstreamCookie: () => 'host-private=secret',
    manage: async () => ({}),
    index: async () => '<!doctype html><title>Host</title>',
    boot: () => bootScript(),
    direct: { offer: async () => ({ sessionId: 'unused', sdp: '' }), resolve: value => value === mark ? deviceId : undefined },
  })
  await gateway.listen('127.0.0.1'); cleanup.push(() => gateway.close())
  const bridge = new DirectBridge({ port: () => gateway.port, mark: () => mark, log: message => console.log('[bridge] ' + message) })
  const wire = channel()
  const session = bridge.attach(wire.transport)
  wire.wire(session)
  return { gateway, bridge, wire, session, deviceId, credential, seen }
}

const open = (wire: ReturnType<typeof channel>, id: string, method: string, path: string, headers: Record<string, string> = {}) =>
  wire.send({ t: 'open', id, payload: controlPayload({ method, path, headers }) })

describe('direct bridge', () => {
  it('carries a Host response over frames, admitted by the channel mark alone', async () => {
    const f = await fixture()
    open(f.wire, 'r1', 'GET', '/api/hello', { accept: 'application/json' })
    const frames = await f.wire.until(list => list.some(frame => frame.t === 'done'))
    const result = JSON.parse(Buffer.from(frames.find(frame => frame.t === 'result')!.payload).toString())
    expect(result.status).toBe(200)
    const body = Buffer.concat(frames.filter(frame => frame.t === 'chunk').map(frame => Buffer.from(frame.payload))).toString()
    expect(JSON.parse(body)).toMatchObject({ path: '/api/hello', size: 0 })
    // The device's own cookie never travels inward: the Host sees only the gateway's session cookie,
    // and the Host's own set-cookie never travels back out to the phone.
    expect(JSON.parse(body).cookie).toBe('host-private=secret')
    expect(JSON.stringify(result.headers)).not.toContain('host-secret')
    // The request did reach the Host, and it was counted on the direct line.
    expect(f.seen.map(entry => entry.path)).toEqual(['/api/hello'])
    expect(f.bridge.snapshot().requests).toBe(1)
    expect(f.session).toBeDefined()
  })

  it('streams a chunked response in order and finishes only after the Host ends it', async () => {
    const f = await fixture()
    open(f.wire, 'r2', 'GET', '/api/stream')
    await new Promise(resolve => setTimeout(resolve, 800))
    await f.wire.until(list => list.some(frame => frame.t === 'done'))
    const chunks = f.wire.out.filter(frame => frame.t === 'chunk').map(frame => Buffer.from(frame.payload).toString())
    expect(chunks.join('')).toContain('第一条')
    expect(chunks.join('')).toContain('第二条')
    expect(f.wire.out.at(-1)!.t).toBe('done')
  })

  it('streams a request body inward and reports its size to the Host', async () => {
    const f = await fixture()
    open(f.wire, 'r3', 'POST', '/api/upload', { 'content-type': 'application/octet-stream' })
    const payload = new Uint8Array(40_000).fill(7)
    for (let offset = 0; offset < payload.length; offset += 16 * 1024) f.wire.send({ t: 'body', id: 'r3', payload: payload.subarray(offset, offset + 16 * 1024) })
    f.wire.send({ t: 'end', id: 'r3', payload: new Uint8Array() })
    await f.wire.until(list => list.some(frame => frame.t === 'done'))
    const body = Buffer.concat(f.wire.out.filter(frame => frame.t === 'chunk').map(frame => Buffer.from(frame.payload))).toString()
    expect(JSON.parse(body).size).toBe(40_000)
  })

  it('refuses a channel whose mark is not bound to a live device', async () => {
    const f = await fixture('mark-1')
    const stranger = new DirectBridge({ port: () => f.gateway.port, mark: () => 'forged' })
    const wire = channel()
    wire.wire(stranger.attach(wire.transport))
    open(wire, 'r4', 'GET', '/api/hello')
    const answer = (await wire.until(list => list.some(frame => frame.t === 'fail' || frame.t === 'result'))).find(frame => frame.t === 'result' || frame.t === 'fail')!
    expect(answer.t).toBe('result')
    expect(JSON.parse(Buffer.from(answer.payload).toString()).status).toBe(403)
  })
})
