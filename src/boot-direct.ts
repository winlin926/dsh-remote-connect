/**
 * The phone's half of the direct line.
 *
 * Written as one self-contained function on purpose: the Host serializes it with toString() into
 * the boot script, exactly like the rest of the injected runtime, so it may not import or capture
 * anything outside its own body.
 */

export interface RemoteDirectOptions {
  signalPath: string
  baseUrl: () => string
  visible?: () => boolean
  preference: () => 'lan' | 'public'
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  onState?: (state: { ready: boolean; line: 'direct' | 'upstream'; reason?: string }) => void
  log?: (line: string) => void
  setTimeout: (fn: () => void, ms: number) => any
  clearTimeout: (handle: any) => void
  setInterval: (fn: () => void, ms: number) => any
  clearInterval: (handle: any) => void
}

export function remoteDirect(options: RemoteDirectOptions) {
  const MAX_FRAME = 16 * 1024
  const TYPES = ['open', 'body', 'end', 'result', 'chunk', 'done', 'fail', 'cancel', 'ws.open', 'ws.ack', 'ws.text', 'ws.bin', 'ws.cont', 'ws.close', 'ping', 'pong', 'hello']
  const ID_OK = /^[A-Za-z0-9_-]{1,64}$/
  const MAX_SOCKET_MESSAGE = 32 * 1024 * 1024
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  function encodeFrame(t: string, id: string, payload: Uint8Array): Uint8Array {
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

  function decodeFrame(bytes: Uint8Array): { t: string; id: string; payload: Uint8Array } {
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

  const control = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value))
  const readControl = (payload: Uint8Array): Record<string, any> => {
    try {
      const value = JSON.parse(decoder.decode(payload) || '{}')
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch { return {} }
  }

  /** One WebSocket carried over the channel, shaped like the browser's own. */
  class ChannelSocket extends EventTarget {
    readyState = 0
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    binaryType: BinaryType = 'arraybuffer'
    readonly url: string
    extensions = ''
    protocol = ''
    bufferedAmount = 0
    readonly sendText: (data: string) => void
    readonly sendBinary: (data: Uint8Array) => void
    readonly sendClose: (code: number, reason: string) => void
    constructor(url: string, sendText: (data: string) => void, sendBinary: (data: Uint8Array) => void, sendClose: (code: number, reason: string) => void) {
      super()
      this.url = url
      this.sendText = sendText
      this.sendBinary = sendBinary
      this.sendClose = sendClose
    }
    emit(event: Event): void {
      this.dispatchEvent(event)
      if (event.type === 'open') this.onopen?.(event)
      else if (event.type === 'message') this.onmessage?.(event as MessageEvent)
      else if (event.type === 'close') this.onclose?.(event as CloseEvent)
      else if (event.type === 'error') this.onerror?.(event)
    }
    emitOpen(protocol: string): void { if (this.readyState !== 0) return; this.protocol = protocol; this.readyState = 1; this.emit(new Event('open')) }
    emitText(data: string): void { if (this.readyState === 1) this.emit(new MessageEvent('message', { data })) }
    emitBinary(data: Uint8Array): void {
      if (this.readyState !== 1) return
      const copy = data.slice()
      const value = this.binaryType === 'blob' ? new Blob([copy]) : copy.buffer
      this.emit(new MessageEvent('message', { data: value }))
    }
    emitError(): void { this.emit(new Event('error')) }
    emitClose(code: number, reason: string, wasClean: boolean): void {
      if (this.readyState === 3) return
      this.readyState = 3
      this.emit(new CloseEvent('close', { code, reason, wasClean }))
    }
    send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
      if (this.readyState === 0) throw new DOMException('WebSocket is not open.', 'InvalidStateError')
      if (this.readyState !== 1) return
      if (typeof data === 'string') { this.sendText(data); return }
      if (data instanceof ArrayBuffer) { this.sendBinary(new Uint8Array(data)); return }
      if (ArrayBuffer.isView(data)) { this.sendBinary(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); return }
      void (data as Blob).arrayBuffer().then(buffer => this.sendBinary(new Uint8Array(buffer)))
    }
    close(code?: number, reason?: string): void {
      if (this.readyState >= 2) return
      this.readyState = 2
      this.sendClose(code ?? 1000, reason ?? '')
    }
  }

  let peer: RTCPeerConnection | undefined
  let channel: RTCDataChannel | undefined
  let sessionId = ''
  let ready = false
  let closed = false
  let retry: any
  let attempt = 0
  let probing: any
  let ticker: any
  let failures = 0
  let opened = false
  let sequence = 0
  let probeId: string | undefined
  let probeStarted = 0
  let directLatency = Infinity
  let directHealthySince = 0
  let hasConnected = false
  let upstreamLatency = Infinity
  let upstreamHealthySince = 0
  let upstreamFailures = 0
  let directSlow = 0
  let upstreamSlow = 0
  let publicProbe: Promise<void> | undefined
  let line: 'direct' | 'upstream' = 'upstream'
  let preference = options.preference()
  interface Call {
    resolve: (response: Response) => void
    reject: (error: unknown) => void
    head: boolean
    timer?: ReturnType<typeof options.setTimeout>
    cleanup?: () => void
    controller?: ReadableStreamDefaultController<Uint8Array>
  }
  const calls = new Map<string, Call>()
  const sockets = new Map<string, { socket: ChannelSocket; chunks: Uint8Array[]; size: number; binary?: boolean }>()

  const report = (reason?: string): void => { options.onState?.({ ready, line, ...(reason ? { reason } : {}) }) }
  const newId = (): string => 'r' + (++sequence).toString(36)

  function selectLine(reason?: string): void {
    const now = Date.now()
    const previous = line
    if (line === 'direct') {
      if (!ready || directSlow >= 3 && upstreamLatency * 2 < directLatency ||
        preference === 'public' && upstreamHealthySince && now - upstreamHealthySince >= 30_000) line = 'upstream'
    } else if (ready && (upstreamFailures >= 2 || upstreamSlow >= 3 && directLatency * 2 < upstreamLatency ||
      preference === 'lan' && (!hasConnected || directHealthySince > 0 && now - directHealthySince >= 30_000))) {
      line = 'direct'
    }
    if (line !== previous || reason) report(reason)
  }

  function probeUpstream(): Promise<void> {
    if (publicProbe || closed) return publicProbe ?? Promise.resolve()
    const started = Date.now()
    const abort = new AbortController()
    const timer = options.setTimeout(() => abort.abort(), 2_000)
    publicProbe = options.fetch(options.signalPath, { method: 'GET', cache: 'no-store', signal: abort.signal, redirect: 'error' })
      .then(async response => {
        if (response.status === 403 && response.headers.get('content-type')?.includes('application/json') &&
          (await response.json().catch(() => null))?.code === 'unpaired') { stop(); return }
        if (response.status !== 204) throw new Error('入口不可达。')
        const preferred = response.headers.get('x-dsh-line-preference')
        if (preferred === 'lan' || preferred === 'public') preference = preferred
        upstreamLatency = Date.now() - started
        upstreamFailures = 0
        upstreamSlow = upstreamLatency >= 1_500 ? upstreamSlow + 1 : 0
        upstreamHealthySince = upstreamSlow ? 0 : upstreamHealthySince || started
      }).catch(() => {
        upstreamFailures++
        upstreamHealthySince = 0
        upstreamLatency = Infinity
      }).finally(() => { options.clearTimeout(timer); publicProbe = undefined; selectLine() })
    return publicProbe
  }

  function send(t: string, id: string, payload: Uint8Array): void {
    if (!channel || channel.readyState !== 'open') throw new Error('直连通道不可用。')
    if (channel.bufferedAmount > 16 * 1024 * 1024) throw new Error('直连发送队列已满。')
    channel.send(encodeFrame(t, id, payload) as Uint8Array<ArrayBuffer>)
  }

  function settle(id: string, error?: Error): void {
    const call = calls.get(id)
    if (!call) return
    calls.delete(id)
    if (call.timer) options.clearTimeout(call.timer)
    call.cleanup?.()
    if (error) { call.controller?.error(error); call.reject(error) }
  }

  function openChannel(): void {
    if (opened || closed) return
    opened = true
    send('hello', 'hello', control({ protocol: 2, sessionId }))
    probe()
    ticker = options.setInterval(probe, 5_000)
  }

  function probe(): void {
    if (closed || options.visible?.() === false || !channel || channel.readyState !== 'open' || probing) return
    void probeUpstream()
    const id = probeId = newId()
    probeStarted = Date.now()
    probing = options.setTimeout(() => {
      probing = undefined
      probeId = undefined
      if (options.visible?.() === false) return
      failures++
      if (failures >= 2) reset('直连线路超时。')
    }, 2_000)
    try { send('ping', id, new Uint8Array()) } catch { reset('直连通道已断开。') }
  }

  function notePong(id: string): void {
    if (id !== probeId) return
    options.clearTimeout(probing)
    probing = undefined
    probeId = undefined
    directLatency = Date.now() - probeStarted
    directSlow = directLatency >= 1_500 ? directSlow + 1 : 0
    failures = 0
    if (!directHealthySince && !directSlow) directHealthySince = probeStarted
    if (directSlow) directHealthySince = 0
    const initial = !ready
    ready = true
    attempt = 0
    selectLine()
    hasConnected = true
    if (initial) report()
  }

  function onFrame(bytes: Uint8Array): void {
    let frame: { t: string; id: string; payload: Uint8Array }
    try { frame = decodeFrame(bytes) } catch { return }
    if (frame.t === 'ping') { try { send('pong', frame.id, frame.payload) } catch { /* gone */ } return }
    if (frame.t === 'pong') { notePong(frame.id); return }
    const pending = sockets.get(frame.id)
    if (frame.t === 'ws.ack') {
      if (!pending) return
      const answer = readControl(frame.payload)
      if (answer.ok !== true) { sockets.delete(frame.id); pending.socket.emitError(); pending.socket.emitClose(1006, 'Connection failed', false); return }
      pending.socket.emitOpen(typeof answer.protocol === 'string' ? answer.protocol : '')
      return
    }
    if (frame.t === 'ws.text' || frame.t === 'ws.bin' || frame.t === 'ws.cont') {
      if (!pending || !frame.payload.length || frame.payload[0] !== 0 && frame.payload[0] !== 1) return
      if (frame.t !== 'ws.cont') {
        if (pending.binary !== undefined) { pending.socket.close(1002, 'Invalid message sequence'); return }
        pending.binary = frame.t === 'ws.bin'
      } else if (pending.binary === undefined) { pending.socket.close(1002, 'Unexpected continuation'); return }
      const chunk = frame.payload.slice(1)
      pending.size += chunk.length
      if (pending.size > MAX_SOCKET_MESSAGE) { pending.socket.close(1009, 'Message too large'); return }
      pending.chunks.push(chunk)
      if (frame.payload[0] === 0) return
      const value = new Uint8Array(pending.size)
      let offset = 0
      for (const part of pending.chunks) { value.set(part, offset); offset += part.length }
      const binary = pending.binary
      pending.chunks = []; pending.size = 0; pending.binary = undefined
      if (binary) pending.socket.emitBinary(value)
      else pending.socket.emitText(decoder.decode(value))
      return
    }
    if (frame.t === 'ws.close') {
      if (!pending) return
      sockets.delete(frame.id)
      const head = readControl(frame.payload)
      pending.socket.emitClose(typeof head.code === 'number' ? head.code : 1000, typeof head.reason === 'string' ? head.reason : '', true)
      return
    }
    if (frame.t === 'result') {
      const call = calls.get(frame.id)
      if (!call) return
      const head = readControl(frame.payload)
      const headers = new Headers()
      const source = head.headers && typeof head.headers === 'object' ? head.headers : {}
      for (const name of Object.keys(source)) {
        const value = source[name]
        if (typeof value === 'string') headers.set(name, value)
        else if (Array.isArray(value)) for (const item of value) if (typeof item === 'string') headers.append(name, item)
      }
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined
      const status = typeof head.status === 'number' ? head.status : 502
      const noBody = call.head || [204, 205, 304].includes(status)
      const stream = noBody ? null : new ReadableStream<Uint8Array>({
        start(next) { controller = next },
        cancel() { cancelCall(frame.id) },
      })
      call.controller = controller
      if (call.timer !== undefined) options.clearTimeout(call.timer)
      call.resolve(new Response(stream, { status, headers }))
      return
    }
    if (frame.t === 'chunk') { const call = calls.get(frame.id); try { call?.controller?.enqueue(frame.payload.slice()) } catch { /* the reader went away */ } return }
    if (frame.t === 'done') {
      const call = calls.get(frame.id)
      if (call) { try { call.controller?.close() } catch { /* already closed */ } settle(frame.id) }
      return
    }
    if (frame.t === 'fail') {
      const head = readControl(frame.payload)
      const error = new Error(typeof head.message === 'string' ? head.message : '直连请求失败。')
      const call = calls.get(frame.id)
      if (call) settle(frame.id, error)
      if (pending) { sockets.delete(frame.id); pending.socket.emitError(); pending.socket.emitClose(1006, 'Connection failed', false) }
    }
  }

  function cancelCall(id: string, error?: Error): void {
    if (!calls.has(id)) return
    try { send('cancel', id, new Uint8Array()) } catch { /* the channel already closed */ }
    settle(id, error)
  }

  function reset(reason: string): void {
    const previous = peer
    const previousChannel = channel
    peer = undefined; channel = undefined; opened = false; ready = false
    sessionId = ''; directHealthySince = 0; directLatency = Infinity; directSlow = 0
    if (ticker !== undefined) options.clearInterval(ticker)
    if (probing !== undefined) options.clearTimeout(probing)
    if (connectTimer !== undefined) options.clearTimeout(connectTimer)
    ticker = probing = probeId = connectTimer = undefined
    selectLine(reason)
    for (const id of calls.keys()) settle(id, new Error(reason))
    const previousSockets = [...sockets.values()]
    sockets.clear()
    for (const { socket } of previousSockets) socket.emitClose(1006, reason, false)
    try { previousChannel?.close() } catch { /* already closed */ }
    try { void Promise.resolve(previous?.close()).catch(() => {}) } catch { /* already closed */ }
    schedule()
  }

  function schedule(): void {
    if (closed || retry !== undefined) return
    const wait = Math.min(30_000, 1_000 * Math.pow(2, attempt++))
    retry = options.setTimeout(() => { retry = undefined; void start() }, wait)
  }

  function stop(): void {
    if (closed) return
    closed = true
    if (retry !== undefined) options.clearTimeout(retry)
    reset('直连已关闭。')
  }

  let connectTimer: ReturnType<typeof options.setTimeout> | undefined
  async function start(): Promise<void> {
    try { await connect() } catch (error) {
      options.log?.('直连建立失败：' + (error instanceof Error ? error.message : String(error)))
      reset('直连线路建立失败。')
    }
  }

  async function connect(): Promise<void> {
    if (closed || peer || options.visible?.() === false) return
    const Connection = globalThis.RTCPeerConnection
    if (!Connection) return
    const local = new Connection({ iceServers: [] })
    peer = local
    const dataChannel = local.createDataChannel('rc-direct', { ordered: true })
    dataChannel.binaryType = 'arraybuffer'
    channel = dataChannel
    failures = 0
    connectTimer = options.setTimeout(() => { if (peer === local) reset('直连协商超时。') }, 15_000)
    dataChannel.onmessage = event => {
      if (peer !== local) return
      const data: unknown = event.data
      if (data instanceof ArrayBuffer) onFrame(new Uint8Array(data))
      else if (data instanceof Uint8Array) onFrame(data)
    }
    dataChannel.onopen = () => {
      if (peer !== local) return
      options.clearTimeout(connectTimer); connectTimer = undefined
      try { openChannel() } catch { reset('直连协商失败。') }
    }
    dataChannel.onclose = () => { if (peer === local) reset('直连通道已断开。') }
    await local.setLocalDescription(await local.createOffer())
    await new Promise<void>(resolve => {
      if (local.iceGatheringState === 'complete') { resolve(); return }
      const finish = () => { options.clearTimeout(timeout); local.removeEventListener('icegatheringstatechange', check); resolve() }
      const check = () => { if (local.iceGatheringState === 'complete') finish() }
      const timeout = options.setTimeout(finish, 3_000)
      local.addEventListener('icegatheringstatechange', check)
    })
    if (peer !== local) return
    const abort = new AbortController()
    const timeout = options.setTimeout(() => abort.abort(), 8_000)
    try {
      const response = await options.fetch(options.signalPath, {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', redirect: 'error',
        body: JSON.stringify({ op: 'offer', sdp: local.localDescription?.sdp ?? '' }), signal: abort.signal,
      })
      if (peer !== local) return
      if (response.status === 403 && response.headers.get('content-type')?.includes('application/json') &&
        (await response.json().catch(() => null))?.code === 'unpaired') { stop(); return }
      if (!response.ok) throw new Error('直连协商被拒绝（HTTP ' + response.status + '）。')
      const answer = await response.json()
      if (peer !== local) return
      if (typeof answer?.sessionId !== 'string' || typeof answer.sdp !== 'string') throw new Error('直连应答无效。')
      sessionId = answer.sessionId
      await local.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
      if (dataChannel.readyState === 'open') dataChannel.onopen?.(new Event('open'))
    } catch (error) { if (peer === local) throw error }
    finally { options.clearTimeout(timeout) }
  }

  return {
    get ready(): boolean { return ready },
    get line(): 'direct' | 'upstream' { return line },
    state() { return { ready, line, failures, session: sessionId } },
    probe: probeUpstream,
    async preferDirectForWrite() {
      await probeUpstream()
      return ready && (line === 'direct' || upstreamFailures > 0)
    },
    checkLines() { if (peer) probe(); else void start() },
    reconnectSockets() { for (const { socket } of sockets.values()) socket.close() },
    start,
    stop,
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const base = options.baseUrl()
      const request = input instanceof Request ? new Request(input, init) : new Request(new URL(String(input), base), init)
      if (!ready || !channel) throw new Error('直连线路不可用。')
      const url = new URL(request.url)
      if (url.origin !== new URL(base).origin) return options.fetch(request)
      const headers: Record<string, string> = {}
      request.headers.forEach((value, name) => { headers[name] = value })
      const method = request.method.toUpperCase()
      const bytes = method === 'GET' || method === 'HEAD' ? new Uint8Array() : new Uint8Array(await request.arrayBuffer())
      if (!ready || !channel) throw new Error('直连线路不可用。')
      const requestId = newId()
      return new Promise<Response>((resolve, reject) => {
        request.signal.throwIfAborted()
        const call: Call = { resolve, reject, head: method === 'HEAD' }
        calls.set(requestId, call)
        const abort = () => cancelCall(requestId, request.signal.reason ?? new DOMException('Request aborted', 'AbortError'))
        request.signal.addEventListener('abort', abort, { once: true })
        call.cleanup = () => request.signal.removeEventListener('abort', abort)
        call.timer = options.setTimeout(() => cancelCall(requestId, new Error('直连请求超时。')), 120_000)
        void (async () => {
          try {
            send('open', requestId, control({ method, path: url.pathname + url.search, headers }))
            for (let offset = 0; offset < bytes.length; offset += MAX_FRAME) send('body', requestId, bytes.subarray(offset, offset + MAX_FRAME))
            send('end', requestId, new Uint8Array())
          } catch (error) { cancelCall(requestId, error instanceof Error ? error : new Error('直连请求发送失败。')) }
        })()
      })
    },
    socket(target: string, protocols?: string | string[]) {
      const url = new URL(target, options.baseUrl())
      const socketId = newId()
      const list = protocols ? (Array.isArray(protocols) ? protocols : [protocols]) : []
      const socket = new ChannelSocket(
        url.href,
        data => sendSocketMessage(socketId, encoder.encode(data), false),
        data => sendSocketMessage(socketId, data, true),
        (code, reason) => {
          try { send('ws.close', socketId, control({ code, reason })) } catch { /* gone */ }
        },
      )
      sockets.set(socketId, { socket, chunks: [], size: 0 })
      try { send('ws.open', socketId, control({ path: url.pathname + url.search, protocols: list })) } catch {
        sockets.delete(socketId)
        options.setTimeout(() => { socket.emitError(); socket.emitClose(1006, 'Connection failed', false) }, 0)
      }
      return socket
    },
  }

  function sendSocketMessage(id: string, data: Uint8Array, binary: boolean): void {
    const type = binary ? 'ws.bin' : 'ws.text'
    const limit = MAX_FRAME - 1
    let offset = 0
    do {
      const end = Math.min(offset + limit, data.length)
      const payload = new Uint8Array(end - offset + 1)
      payload[0] = end === data.length ? 1 : 0
      payload.set(data.subarray(offset, end), 1)
      send(offset === 0 ? type : 'ws.cont', id, payload)
      offset = end
    } while (offset < data.length)
  }
}
