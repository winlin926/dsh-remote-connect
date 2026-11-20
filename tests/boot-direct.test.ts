import { afterEach, describe, expect, it, vi } from 'vitest'
import { remoteDirect } from '../src/boot-direct.js'

/** One fake DataChannel: what the page sends, and a way to hand frames back. */
function fakePeer() {
  const sent: Array<{ t: number; id: string; payload: Uint8Array }> = []
  const channel = {
    readyState: 'connecting' as string,
    onmessage: null as ((event: { data: ArrayBuffer }) => void) | null,
    onopen: null as (() => void) | null,
    onclose: null as (() => void) | null,
    send(data: Uint8Array) { sent.push({ t: data[0]!, id: '', payload: data }) },
    close() { this.readyState = 'closed' },
  }
  class Peer {
    iceGatheringState = 'complete'
    localDescription: { sdp: string } | null = null
    createDataChannel() { return channel }
    addEventListener() {}
    removeEventListener() {}
    async createOffer() { return { type: 'offer', sdp: 'v=0' } }
    async setLocalDescription() { this.localDescription = { sdp: 'v=0\r\n' } }
    async setRemoteDescription() {}
    close() {}
  }
  ;(globalThis as Record<string, unknown>).RTCPeerConnection = Peer as never
  return { channel, sent }
}

const TYPES = ['open', 'body', 'end', 'result', 'chunk', 'done', 'fail', 'cancel', 'ws.open', 'ws.ack', 'ws.text', 'ws.bin', 'ws.cont', 'ws.close', 'ping', 'pong', 'hello']
const encode = (t: string, id: string, payload: Uint8Array) => {
  const out = new Uint8Array(3 + id.length + payload.length)
  out[0] = TYPES.indexOf(t) + 1
  out[1] = id.length >> 8; out[2] = id.length & 0xff
  for (let i = 0; i < id.length; i++) out[3 + i] = id.charCodeAt(i)
  out.set(payload, 3 + id.length)
  return out
}
const control = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const readId = (bytes: Uint8Array) => {
  const length = (bytes[1]! << 8) | bytes[2]!
  let id = ''
  for (let i = 0; i < length; i++) id += String.fromCharCode(bytes[3 + i]!)
  return id
}
const readType = (bytes: Uint8Array) => TYPES[bytes[0]! - 1]!

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

describe('phone direct client', () => {
  afterEach(() => { delete (globalThis as Record<string, unknown>).RTCPeerConnection })

  it('opens only after a probe answers, then carries a whole request over the channel', async () => {
    const peer = fakePeer()
    const created = remoteDirect({
      signalPath: '/rc/direct/signal',
      baseUrl: () => 'http://127.0.0.1:18443/',
      preference: () => 'lan',
      fetch: async (_input, init) => init?.method === 'GET' ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ sessionId: 's-1', sdp: 'v=0' }), { status: 200 }),
      setTimeout: (fn, ms) => setTimeout(fn, ms) as never,
      clearTimeout: handle => clearTimeout(handle),
      setInterval: () => 0 as never,
      clearInterval: () => {},
    })
    await created.start()
    expect(created.ready).toBe(false)
    peer.channel.readyState = 'open'
    peer.channel.onopen?.()
    await settle()
    const hello = peer.sent.find(frame => readType(frame.payload) === 'hello')
    expect(hello).toBeDefined()
    // A pong for the probe is what makes the line usable; a channel that merely exists is not.
    peer.channel.onmessage?.({ data: encode('pong', readId(peer.sent.find(frame => readType(frame.payload) === 'ping')!.payload), new Uint8Array()).buffer as ArrayBuffer })
    expect(created.ready).toBe(true)
    expect(created.line).toBe('direct')
    const pending = created.fetch('/api/hello?x=1', { method: 'POST', body: 'body-bytes' })
    await settle()
    const open = peer.sent.find(frame => readType(frame.payload) === 'open')!
    expect(readId(open.payload)).toBeTruthy()
    const requestId = readId(open.payload)
    peer.channel.onmessage?.({ data: encode('result', requestId, control({ status: 200, headers: { 'content-type': 'text/plain' } })).buffer as ArrayBuffer })
    peer.channel.onmessage?.({ data: encode('chunk', requestId, new TextEncoder().encode('hello ')).buffer as ArrayBuffer })
    peer.channel.onmessage?.({ data: encode('chunk', requestId, new TextEncoder().encode('world')).buffer as ArrayBuffer })
    peer.channel.onmessage?.({ data: encode('done', requestId, new Uint8Array()).buffer as ArrayBuffer })
    const response = await pending
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('hello world')
  })

  it('goes back to the upstream line when the channel closes', async () => {
    const peer = fakePeer()
    const created = remoteDirect({
      signalPath: '/rc/direct/signal',
      baseUrl: () => 'http://127.0.0.1:18443/',
      preference: () => 'lan',
      fetch: async (_input, init) => init?.method === 'GET' ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ sessionId: 's', sdp: 'v=0' }), { status: 200 }),
      setTimeout: (fn, ms) => setTimeout(fn, ms) as never,
      clearTimeout: handle => clearTimeout(handle),
      setInterval: () => 0 as never,
      clearInterval: () => {},
    })
    await created.start()
    peer.channel.readyState = 'open'
    peer.channel.onopen?.()
    peer.channel.onmessage?.({ data: encode('pong', readId(peer.sent.find(frame => readType(frame.payload) === 'ping')!.payload), new Uint8Array()).buffer as ArrayBuffer })
    expect(created.line).toBe('direct')
    peer.channel.onclose?.()
    expect(created.ready).toBe(false)
    expect(created.line).toBe('upstream')
    created.stop()
  })

  it('keeps public preference through one bad probe, fails over, and waits before returning', async () => {
    vi.useFakeTimers()
    const peer = fakePeer()
    let available = true
    const link = remoteDirect({
      signalPath: '/rc/direct/signal', baseUrl: () => 'https://example.test/', preference: () => 'public',
      fetch: async (_input, init) => init?.method === 'POST'
        ? Response.json({ sessionId: 's', sdp: 'v=0' })
        : new Response(null, { status: available ? 204 : 503 }),
      setTimeout, clearTimeout, setInterval, clearInterval,
    })
    const answer = () => {
      const ping = peer.sent.findLast(frame => readType(frame.payload) === 'ping')!
      peer.channel.onmessage?.({ data: encode('pong', readId(ping.payload), new Uint8Array()).buffer as ArrayBuffer })
    }
    try {
      await link.start()
      peer.channel.readyState = 'open'
      peer.channel.onopen?.()
      answer()
      await link.probe()
      expect(link.line).toBe('upstream')
      available = false
      await link.probe()
      expect(link.line).toBe('upstream')
      await link.probe()
      expect(link.line).toBe('direct')
      available = true
      await link.probe()
      expect(link.line).toBe('direct')
      for (let i = 0; i < 6; i++) { await vi.advanceTimersByTimeAsync(5000); answer() }
      expect(link.line).toBe('upstream')
    } finally { link.stop(); vi.useRealTimers() }
  })

})
