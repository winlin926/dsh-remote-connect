import { afterEach, describe, expect, it } from 'vitest'
import { chooseLine, controlBytes, createDirectLink, decodeDirect, encodeDirect, readControlBytes } from '../src/boot-direct.js'

/** One fake DataChannel; frames are read back with the same codec the page uses. */
function fakePeer() {
  const sent: Array<{ t: string; id: string; payload: Uint8Array }> = []
  const channel = {
    readyState: 'connecting' as string,
    onmessage: null as ((event: { data: ArrayBuffer }) => void) | null,
    onopen: null as (() => void) | null,
    onclose: null as (() => void) | null,
    send(data: Uint8Array) { sent.push(decodeDirect(data)) },
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
  }
  // The page reads the global when it opens the peer, exactly as a browser provides it.
  ;(globalThis as Record<string, unknown>).RTCPeerConnection = Peer as never
  return {
    channel,
    sent,
    open() { channel.readyState = 'open'; channel.onopen?.() },
    deliver(frame: { t: string; id: string; payload: Uint8Array }) {
      const bytes = encodeDirect(frame.t, frame.id, frame.payload)
      channel.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer })
    },
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

async function link(peer: ReturnType<typeof fakePeer>, preference: 'lan' | 'public' = 'lan') {
  const created = createDirectLink({
    signalPath: '/rc/direct/signal',
    fetch: async () => new Response(JSON.stringify({ sessionId: 'session-1', sdp: 'v=0\r\n' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    WebSocket: class {} as never,
    setTimeout: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as never,
    clearTimeout: ((handle: never) => clearTimeout(handle)) as never,
    setInterval: (() => 0) as never,
    clearInterval: (() => {}) as never,
    random: () => 'unit-test-id',
    baseUrl: () => 'http://127.0.0.1:8443/?x=1',
    preference: () => preference,
  })
  await created.start()
  peer.open()
  await settle()
  return created
}

describe('direct frame codec', () => {
  it('round-trips a control frame and a body frame', () => {
    const control = encodeDirect('open', 'abc_1', controlBytes({ method: 'GET', path: '/api/x' }))
    const decoded = decodeDirect(control)
    expect(decoded.t).toBe('open')
    expect(decoded.id).toBe('abc_1')
    expect(readControlBytes(decoded.payload)).toMatchObject({ method: 'GET', path: '/api/x' })
    const body = encodeDirect('body', 'abc_1', new Uint8Array([1, 2, 3]))
    expect(Array.from(decodeDirect(body).payload!)).toEqual([1, 2, 3])
  })

  it('refuses an oversized frame and an invalid id', () => {
    expect(() => encodeDirect('body', 'ok', new Uint8Array(16 * 1024 + 1))).toThrow()
    expect(() => encodeDirect('body', 'bad id', new Uint8Array(1))).toThrow()
  })
})

describe('line choice', () => {
  it('uses the direct line only when it is ready and this phone prefers the LAN line', () => {
    expect(chooseLine({ directReady: true, preferred: 'lan' })).toBe('direct')
    expect(chooseLine({ directReady: true, preferred: 'public' })).toBe('upstream')
    expect(chooseLine({ directReady: false, preferred: 'lan' })).toBe('upstream')
  })
})

describe('direct link', () => {
  afterEach(() => { delete (globalThis as Record<string, unknown>).RTCPeerConnection })

  it('is not usable until the channel answers a probe, then carries one whole request', async () => {
    const peer = fakePeer()
    const created = await link(peer)
    expect(created.ready).toBe(false)
    // The page sent its hello first; a pong for the probe that followed makes the line usable.
    expect(peer.sent[0]!.t).toBe('hello')
    peer.deliver({ t: 'pong', id: 'probe', payload: controlBytes({ at: Date.now() - 4 }) })
    expect(created.ready).toBe(true)
    expect(created.line).toBe('direct')
    const pending = created.fetch('/api/hello?x=1', { method: 'POST', body: 'ping-body' })
    await settle()
    const types = peer.sent.map(frame => frame.t)
    expect(types).toContain('open')
    expect(types).toContain('body')
    expect(types).toContain('end')
    const open = peer.sent.find(frame => frame.t === 'open')!
    expect(readControlBytes(open.payload)).toMatchObject({ method: 'POST', path: '/api/hello?x=1' })
    peer.deliver({ t: 'result', id: open.id, payload: controlBytes({ status: 200, headers: { 'content-type': 'text/plain' } }) })
    peer.deliver({ t: 'chunk', id: open.id, payload: new TextEncoder().encode('hello ') })
    peer.deliver({ t: 'chunk', id: open.id, payload: new TextEncoder().encode('world') })
    peer.deliver({ t: 'done', id: open.id, payload: new Uint8Array() })
    const response = await pending
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('hello world')
  })

  it('drops the line after two missed probes and reports the reason', async () => {
    const peer = fakePeer()
    const reasons: string[] = []
    const created = createDirectLink({
      signalPath: '/rc/direct/signal',
      fetch: async () => new Response(JSON.stringify({ sessionId: 's', sdp: 'v=0' }), { status: 200 }),
      WebSocket: class {} as never,
      setTimeout: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as never,
      clearTimeout: ((handle: never) => clearTimeout(handle)) as never,
      setInterval: (() => 0) as never,
      clearInterval: (() => {}) as never,
      random: () => 'unit',
      baseUrl: () => 'http://127.0.0.1:8443/',
      preference: () => 'lan',
      onState: state => { if (state.reason) reasons.push(state.reason) },
    })
    await created.start()
    peer.open()
    await settle()
    peer.deliver({ t: 'pong', id: 'probe', payload: controlBytes({ at: Date.now() }) })
    expect(created.ready).toBe(true)
    created.stop()
    expect(created.ready).toBe(false)
    expect(reasons.join('')).toContain('直连已关闭')
  })
})
