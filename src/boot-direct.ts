/**
 * The phone's half of the direct line: one WebRTC DataChannel carrying the page's own HTTP and
 * WebSocket traffic, plus the small state machine that decides which line serves it.
 *
 * Everything here is serialized into the boot script, so it may not import or capture anything:
 * the frame codec and the thresholds are duplicated deliberately and stay in this file.
 */

export interface DirectLinkOptions {
  /** Absolute same-origin URL that answers an offer. */
  signalPath: string
  /** Called with a short Chinese reason when the line drops; the page decides what to show. */
  onState?: (state: { ready: boolean; reason?: string }) => void
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  WebSocket: typeof WebSocket
  setTimeout: (fn: () => void, ms: number) => any
  clearTimeout: (handle: any) => void
  setInterval: (fn: () => void, ms: number) => any
  clearInterval: (handle: any) => void
  random: () => string
  /** The page's own address; the link never reaches for a browser global it cannot be handed. */
  baseUrl: () => string
  /** Read per call: the preference may change while a line is live. */
  preference: () => 'lan' | 'public'
}

export interface DirectLineState {
  ready: boolean
  reason?: string
  line: 'direct' | 'upstream'
  probes: number
  failures: number
}

const MAX_FRAME = 16 * 1024
const TYPES = ['open', 'body', 'end', 'result', 'chunk', 'done', 'fail', 'cancel', 'ws.open', 'ws.ack', 'ws.text', 'ws.bin', 'ws.close', 'ping', 'pong', 'hello']
const ID_OK = /^[A-Za-z0-9_-]{1,64}$/

/** Phone-side probe cadence and switch thresholds; the panel documents these same numbers. */
export const DIRECT_PROBE_INTERVAL_MS = 5_000
export const DIRECT_PROBE_TIMEOUT_MS = 2_000
/** Two answers missing in a row means the line this page is on is gone. */
export const DIRECT_SWITCH_AFTER_TIMEOUTS = 2
/** Or three slow answers in a row while the other line is at most half as slow. */
export const DIRECT_SWITCH_AFTER_SLOW = 3
export const DIRECT_SLOW_MS = 1_500
/** How long the preferred line must stay healthy before traffic returns to it. */
export const DIRECT_RECOVER_MS = 30_000

export function encodeDirect(t: string, id: string, payload: Uint8Array): Uint8Array {
  const code = TYPES.indexOf(t) + 1
  if (!code) throw new Error('未知的直连帧类型。')
  if (!ID_OK.test(id)) throw new Error('直连帧的 id 不合法。')
  if (payload.length > MAX_FRAME) throw new Error('直连帧超过大小上限。')
  const out = new Uint8Array(3 + id.length + payload.length)
  out[0] = code
  out[1] = id.length >> 8
  out[2] = id.length & 0xff
  for (let index = 0; index < id.length; index++) out[3 + index] = id.charCodeAt(index)
  out.set(payload, 3 + id.length)
  return out
}

export function decodeDirect(bytes: Uint8Array): { t: string; id: string; payload: Uint8Array } {
  if (bytes.length < 3) throw new Error('直连帧过短。')
  const t = TYPES[bytes[0]! - 1]
  if (!t) throw new Error('未知的直连帧类型。')
  const length = (bytes[1]! << 8) | bytes[2]!
  if (bytes.length < 3 + length) throw new Error('直连帧的 id 长度不合法。')
  let id = ''
  for (let index = 0; index < length; index++) id += String.fromCharCode(bytes[3 + index]!)
  if (!ID_OK.test(id)) throw new Error('直连帧的 id 不合法。')
  return { t, id, payload: bytes.subarray(3 + length) }
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
export function controlBytes(value: unknown): Uint8Array { return textEncoder.encode(JSON.stringify(value)) }
export function readControlBytes(payload: Uint8Array): Record<string, any> {
  try { const value = JSON.parse(textDecoder.decode(payload) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {} } catch { return {} }
}

/** The line the page will use next, given what is live and what the user prefers. */
export function chooseLine(state: { directReady: boolean; preferred: 'lan' | 'public' }): 'direct' | 'upstream' {
  return state.directReady && state.preferred === 'lan' ? 'direct' : 'upstream'
}

interface PendingHttp {
  controller?: ReadableStreamDefaultController<Uint8Array>
  resolve: (response: Response) => void
  reject: (error: Error) => void
  timer?: any
}

interface PendingSocket {
  socket: DirectSocket
  ack?: (value: any) => void
}

/** The subset of WebSocket the Host's page actually uses, carried over the channel. */
export class DirectSocket extends EventTarget {
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  binaryType = 'arraybuffer'
  constructor(readonly url: string, readonly protocols?: string | string[]) { super() }
  send(): void { throw new Error('not wired') }
  close(): void { this.readyState = 3 }
}

/**
 * One direct line. It is usable only after the channel opens, the hello is answered and one probe
 * has come back: a channel that merely exists is not a line that works.
 */
export function createDirectLink(options: DirectLinkOptions) {
  let peer: any
  let channel: any
  let sessionId = ''
  let ready = false
  let closed = false
  let probing: any
  let failures = 0
  let slow = 0
  let healthySince = 0
  let lastLatency = 0
  const calls = new Map<string, PendingHttp>()
  const sockets = new Map<string, PendingSocket>()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const report = (reason?: string): void => { options.onState?.({ ready, ...(reason ? { reason } : {}) }) }
  const id = (): string => options.random().replace(/[^A-Za-z0-9]/g, '').slice(0, 10) + Math.floor(Math.random() * 1e6).toString(36).slice(0, 4)

  function send(t: string, frameId: string, payload: Uint8Array): void {
    if (!channel || channel.readyState !== 'open') throw new Error('直连通道不可用。')
    channel.send(encodeDirect(t, frameId, payload))
  }

  function fail(id: string, error: Error): void {
    const call = calls.get(id)
    if (!call) return
    calls.delete(id)
    if (call.timer) options.clearTimeout(call.timer)
    call.reject(error)
  }

  function onFrame(bytes: Uint8Array): void {
    let frame: { t: string; id: string; payload: Uint8Array }
    try { frame = decodeDirect(bytes) } catch { return }
    switch (frame.t) {
      case 'result': {
        const call = calls.get(frame.id)
        if (!call) return
        const head = readControlBytes(frame.payload)
        const stream = new ReadableStream<Uint8Array>({ start(controller) { call.controller = controller } })
        const headers = new Headers()
        const source = head.headers && typeof head.headers === 'object' ? head.headers : {}
        for (const name of Object.keys(source)) {
          const value = source[name]
          if (typeof value === 'string') headers.set(name, value)
          else if (Array.isArray(value)) for (const item of value) if (typeof item === 'string') headers.append(name, item)
        }
        call.resolve(new Response(stream, { status: typeof head.status === 'number' ? head.status : 502, headers }))
        return
      }
      case 'chunk': calls.get(frame.id)?.controller?.enqueue(frame.payload.slice()); return
      case 'done': {
        const call = calls.get(frame.id)
        if (!call) return
        calls.delete(frame.id)
        if (call.timer) options.clearTimeout(call.timer)
        call.controller?.close()
        return
      }
      case 'fail': {
        const call = calls.get(frame.id)
        const reason = readControlBytes(frame.payload)
        const error = new Error(typeof reason.message === 'string' ? reason.message : '直连请求失败。')
        if (call) { call.controller?.error(error); fail(frame.id, error) }
        const pendingSocket = sockets.get(frame.id)
        if (pendingSocket) { sockets.delete(frame.id); pendingSocket.ack?.(reason); pendingSocket.socket.readyState = 3; pendingSocket.socket.onerror?.(new Event('error')) }
        return
      }
      case 'ws.ack': {
        const pendingSocket = sockets.get(frame.id)
        const head = readControlBytes(frame.payload)
        if (!pendingSocket) return
        if (head.ok !== true) { sockets.delete(frame.id); pendingSocket.socket.readyState = 3; pendingSocket.socket.onerror?.(new Event('error')); return }
        pendingSocket.socket.readyState = 1
        pendingSocket.socket.onopen?.(new Event('open'))
        return
      }
      case 'ws.text': {
        const pendingSocket = sockets.get(frame.id)
        if (pendingSocket) pendingSocket.socket.onmessage?.(new MessageEvent('message', { data: decoder.decode(frame.payload) }))
        return
      }
      case 'ws.bin': {
        const pendingSocket = sockets.get(frame.id)
        if (pendingSocket) pendingSocket.socket.onmessage?.(new MessageEvent('message', { data: frame.payload.slice().buffer }))
        return
      }
      case 'ws.close': {
        const pendingSocket = sockets.get(frame.id)
        if (!pendingSocket) return
        sockets.delete(frame.id)
        pendingSocket.socket.readyState = 3
        pendingSocket.socket.onclose?.(new CloseEvent('close', readControlBytes(frame.payload) as any))
        return
      }
      case 'ping': { try { send('pong', frame.id, frame.payload) } catch { /* the channel is gone */ } return }
      case 'pong': { notePong(Number(readControlBytes(frame.payload).at ?? 0)); return }
      default: return
    }
  }

  function notePong(at: number): void {
    if (!probing) return
    options.clearTimeout(probing)
    probing = undefined
    lastLatency = at ? Date.now() - at : 0
    failures = 0
    slow = lastLatency > 1_500 ? slow + 1 : 0
    if (!healthySince) healthySince = Date.now()
    if (!ready) { ready = true; report() }
  }

  function probe(): void {
    if (closed || !channel || channel.readyState !== 'open') return
    if (probing) return
    const at = Date.now()
    probing = options.setTimeout(() => {
      probing = undefined
      failures += 1
      if (failures >= DIRECT_SWITCH_AFTER_TIMEOUTS && ready) { ready = false; healthySince = 0; report('直连线路超时。') }
    }, 2_000)
    try { send('ping', 'probe', controlBytes({ at })) } catch { failures += 1; if (failures >= DIRECT_SWITCH_AFTER_TIMEOUTS && ready) { ready = false; healthySince = 0; report('直连通道已关闭。') } }
  }

  async function connect(): Promise<void> {
    if (closed || peer) return
    const Connection = (globalThis as any).RTCPeerConnection
    if (!Connection) { report('该浏览器不支持直连线路。'); return }
    const local: any = new Connection({ iceServers: [] })
    peer = local
    const dataChannel = local.createDataChannel('rc-direct', { ordered: true })
    channel = dataChannel
    dataChannel.onmessage = (event: MessageEvent) => {
      const data = event.data
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : undefined
      if (bytes) onFrame(bytes)
    }
    let opened = false
    const onOpen = (): void => {
      if (opened) return
      opened = true
      try { send('hello', 'hello', controlBytes({ protocol: 1, sessionId })) } catch { /* the answer carries the session */ }
      probe()
      timer = options.setInterval(probe, 5_000)
    }
    dataChannel.onopen = onOpen
    dataChannel.onclose = () => { if (ready) { ready = false; healthySince = 0; report('直连通道已断开。') } }
    const gather = new Promise<void>(resolve => {
      if (local.iceGatheringState === 'complete') return resolve()
      const check = () => { if (local.iceGatheringState === 'complete') { local.removeEventListener('icegatheringstatechange', check); resolve() } }
      local.addEventListener('icegatheringstatechange', check)
      options.setTimeout(resolve, 3_000)
    })
    const offer = await local.createOffer()
    await local.setLocalDescription(offer)
    await gather
    const answer = await options.fetch(options.signalPath, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'offer', sdp: local.localDescription?.sdp ?? '' }), credentials: 'same-origin',
    })
    if (!answer.ok) throw new Error('直连协商被拒绝（HTTP ' + answer.status + '）。')
    const data = await answer.json()
    sessionId = typeof data?.sessionId === 'string' ? data.sessionId : ''
    await local.setRemoteDescription({ type: 'answer', sdp: String(data?.sdp ?? '') })
    // Not every runtime fires `onopen` as a property: watching the state covers both, once.
    const watch = () => { if (dataChannel.readyState === 'open') onOpen(); else if (!opened && !closed) options.setTimeout(watch, 100) }
    watch()
  }

  let timer: any

  return {
    get ready(): boolean { return ready },
    get line(): 'direct' | 'upstream' { return chooseLine({ directReady: ready, preferred: options.preference() }) },
    get latency(): number { return lastLatency },
    state(): DirectLineState { return { ready, line: this.line, probes: failures, failures, reason: ready ? undefined : undefined } as DirectLineState },
    async start(): Promise<void> {
      try { await connect() } catch (error) { report(error instanceof Error ? error.message : '直连线路建立失败。') }
    },
    stop(): void {
      closed = true
      if (timer) options.clearInterval(timer)
      if (probing) options.clearTimeout(probing)
      for (const key of [...calls.keys()]) fail(key, new Error('直连已关闭。'))
      sockets.clear()
      try { channel?.close() } catch { /* already gone */ }
      try { peer?.close() } catch { /* already gone */ }
      peer = undefined; channel = undefined; ready = false
      report('直连已关闭。')
    },
    /** One HTTP request over the channel, shaped like fetch. */
    fetch(input: string, init?: RequestInit): Promise<Response> {
      if (!ready || !channel) return Promise.reject(new Error('直连线路不可用。'))
      const requestId = id()
      const url = new URL(input, options.baseUrl())
      if (url.origin !== new URL(options.baseUrl()).origin) return options.fetch(input, init)
      const headers: Record<string, string> = {}
      new Headers(init?.headers ?? {}).forEach((value, name) => { headers[name] = value })
      return new Promise<Response>((resolve, reject) => {
        const call: PendingHttp = { resolve, reject }
        calls.set(requestId, call)
        call.timer = options.setTimeout(() => { const error = new Error('直连请求超时。'); fail(requestId, error) }, 120_000)
        const sendBody = async (): Promise<void> => {
          try {
            send('open', requestId, controlBytes({ method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname + url.search, headers }))
            const body = init?.body
            if (body !== undefined && body !== null) {
              const bytes = typeof body === 'string' ? encoder.encode(body) : body instanceof ArrayBuffer ? new Uint8Array(body) : body instanceof Uint8Array ? body : new Uint8Array(await new Response(body as any).arrayBuffer())
              for (let offset = 0; offset < bytes.length; offset += MAX_FRAME) send('body', requestId, bytes.subarray(offset, offset + MAX_FRAME))
            }
            send('end', requestId, new Uint8Array())
          } catch (error) { fail(requestId, error instanceof Error ? error : new Error('直连请求发送失败。')) }
        }
        void sendBody()
      })
    },
    /** One WebSocket over the channel; the caller speaks the ordinary WebSocket API. */
    socket(target: string, protocols?: string | string[]): WebSocket {
      const url = new URL(target, options.baseUrl())
      const socket = new DirectSocket(url.href, protocols) as unknown as WebSocket & { readyState: number }
      const socketId = id()
      const pending: PendingSocket = { socket: socket as unknown as DirectSocket }
      sockets.set(socketId, pending)
      const self = socket as any
      self.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView): void => {
        try {
          if (typeof data === 'string') send('ws.text', socketId, encoder.encode(data))
          else if (data instanceof ArrayBuffer) send('ws.bin', socketId, new Uint8Array(data))
          else if (ArrayBuffer.isView(data)) send('ws.bin', socketId, new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
          else void (data as Blob).arrayBuffer().then(buffer => send('ws.bin', socketId, new Uint8Array(buffer)))
        } catch { /* the channel is gone; close reports it */ }
      }
      self.close = (code?: number, reason?: string): void => {
        try { send('ws.close', socketId, controlBytes({ code: code ?? 1000, reason: reason ?? '' })) } catch { /* already gone */ }
        sockets.delete(socketId)
        self.readyState = 3
      }
      try { send('ws.open', socketId, controlBytes({ path: url.pathname + url.search, protocols: protocols ? (Array.isArray(protocols) ? protocols : [protocols]) : [] })) }
      catch { sockets.delete(socketId); self.readyState = 3; setTimeout(() => self.onerror?.(new Event('error')), 0) }
      return socket
    },
  }
}

