import { request as httpRequest } from 'node:http'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { WebSocket } from 'ws'
import { safePath, closeCode } from '../gateway.js'
import {
  DIRECT_MAX_FRAME, DIRECT_REQUEST_TIMEOUT_MS, DIRECT_MARK, DirectFrameError,
  controlPayload, decodeDirectFrame, encodeDirectFrame, readControl, type DirectFrame,
} from './protocol.js'

/** Everything the bridge needs from the connection it rides on. */
export interface DirectTransport {
  send(data: Uint8Array): void
  close(): void
  /** Bytes queued but not yet handed to the network, when the transport can report it. */
  bufferedAmount?: number
}

export interface DirectBridgeOptions {
  /** The gateway's own loopback port: direct traffic is authorized exactly like remote traffic. */
  port: () => number
  /** Written on every loopback request; resolves to the paired device this channel was bound to. */
  mark: () => string
  log?: (message: string) => void
  requestTimeoutMs?: number
}

export interface DirectStats { requests: number; sockets: number; received: number; sent: number }
const MAX_SOCKET_MESSAGE = 32 * 1024 * 1024
const MAX_EXCHANGES = 32

/** Headers a frame may not control: they describe this hop, not the phone's request. */
const BLOCKED = new Set([
  'host', 'cookie', 'authorization', 'origin', 'referer', 'connection', 'upgrade', 'keep-alive',
  'transfer-encoding', 'content-length', 'accept-encoding', 'sec-fetch-site', 'sec-websocket-key',
  'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol', 'te', 'trailer',
  'proxy-authorization', 'proxy-connection', 'upgrade-insecure-requests',
])

interface HttpCall { req: ClientRequest; res?: IncomingMessage; timer?: ReturnType<typeof setTimeout>; ended?: boolean }
interface SocketMessage { binary: boolean; chunks: Buffer[]; size: number }

/**
 * One direct connection's traffic, carried as frames and replayed against the computer's own
 * gateway over loopback. Nothing here decides who may connect: the gateway does that, from the
 * mark this class stamps, so a direct request is authorized by exactly the rules a remote one is.
 */
export class DirectBridge {
  private readonly calls = new Map<string, HttpCall>()
  private readonly sockets = new Map<string, WebSocket>()
  private readonly socketMessages = new Map<string, SocketMessage>()
  private disposed = false
  private readonly stats: DirectStats = { requests: 0, sockets: 0, received: 0, sent: 0 }

  constructor(private readonly options: DirectBridgeOptions) {}

  snapshot(): DirectStats { return { ...this.stats } }

  attach(transport: DirectTransport): { handle: (data: Uint8Array) => void; dispose: () => void } {
    const send = (frame: DirectFrame): void => {
      if (this.disposed) return
      try {
        const bytes = encodeDirectFrame(frame)
        this.stats.sent += bytes.length
        transport.send(bytes)
      } catch (failure) { this.options.log?.('直连帧编码失败：' + describe(failure)) }
    }
    const reply = (t: DirectFrame['t'], id: string, value: unknown): void => send({ t, id, payload: controlPayload(value) })
    const fail = (id: string, code: string, message: string): void => reply('fail', id, { code, message })

    return {
      handle: (data: Uint8Array): void => {
        if (this.disposed) return
        this.stats.received += data.length
        let frame: DirectFrame
        try { frame = decodeDirectFrame(data) } catch (failure) { this.options.log?.('直连帧被拒绝：' + describe(failure)); return }
        try { switch (frame.t) {
          case 'ping': reply('pong', frame.id, readControl(frame)); return
          case 'pong': return
          case 'open': this.open(frame.id, readControl(frame), send, fail); return
          case 'body': this.write(frame.id, frame.payload); return
          case 'end': this.endCall(frame.id); return
          case 'cancel': this.cancel(frame.id); return
          case 'ws.open': this.openSocket(frame.id, readControl(frame), reply, send); return
          case 'ws.text': this.startSocketMessage(frame.id, false, frame.payload); return
          case 'ws.bin': this.startSocketMessage(frame.id, true, frame.payload); return
          case 'ws.cont': this.continueSocketMessage(frame.id, frame.payload); return
          case 'ws.close': this.closeSocket(frame.id, readControl(frame)); return
          default: return
        } } catch { fail(frame.id, 'INVALID_REQUEST', '直连请求格式不合法。') }
      },
      dispose: (): void => {
        this.disposed = true
        for (const id of [...this.calls.keys()]) this.cancel(id)
        for (const id of [...this.sockets.keys()]) this.sockets.get(id)?.terminate()
        this.sockets.clear()
        this.socketMessages.clear()
      },
    }
  }

  private headers(input: Record<string, unknown>, port: number): Record<string, string> {
    const headers: Record<string, string> = {}
    const source = input.headers
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
        const key = name.toLowerCase()
        if (BLOCKED.has(key) || key.startsWith('x-forwarded') || key.startsWith('x-dsh-rc')) continue
        if (typeof value === 'string') headers[key] = value
        else if (Array.isArray(value)) headers[key] = value.filter(item => typeof item === 'string').join(', ')
      }
    }
    const host = '127.0.0.1:' + port
    return { ...headers, host, origin: 'http://' + host, 'sec-fetch-site': 'same-origin', 'accept-encoding': 'identity', [DIRECT_MARK]: this.options.mark() }
  }

  private open(id: string, input: Record<string, unknown>, send: (frame: DirectFrame) => void, fail: (id: string, code: string, message: string) => void): void {
    if (this.calls.has(id) || this.sockets.has(id) || this.calls.size + this.sockets.size >= MAX_EXCHANGES) { fail(id, 'BUSY', '直连请求数量达到上限或请求重复。'); return }
    const method = typeof input.method === 'string' ? input.method.toUpperCase() : 'GET'
    const path = typeof input.path === 'string' && safePath(input.path) ? input.path : undefined
    if (!path) { fail(id, 'BAD_PATH', '直连请求路径不合法。'); return }
    const port = this.options.port()
    if (!port) { fail(id, 'NO_GATEWAY', '本机网关未开启。'); return }
    this.stats.requests += 1
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: this.headers(input, port) })
    const call: HttpCall = { req }
    this.calls.set(id, call)
    call.timer = setTimeout(() => { this.cancel(id); fail(id, 'TIMEOUT', '直连请求超时。') }, this.options.requestTimeoutMs ?? DIRECT_REQUEST_TIMEOUT_MS)
    if (call.timer.unref) call.timer.unref()
    req.on('response', res => {
      call.res = res
      if (call.timer) clearTimeout(call.timer)
      const headers: Record<string, string | string[]> = {}
      for (const [name, value] of Object.entries(res.headers)) {
        if (value === undefined || name === 'connection' || name === 'transfer-encoding' || name === 'keep-alive' || name === 'set-cookie') continue
        headers[name] = value
      }
      send({ t: 'result', id, payload: controlPayload({ status: res.statusCode ?? 502, headers }) })
      res.on('data', (chunk: Buffer) => {
        for (let offset = 0; offset < chunk.length; offset += DIRECT_MAX_FRAME) {
          send({ t: 'chunk', id, payload: new Uint8Array(chunk.subarray(offset, offset + DIRECT_MAX_FRAME)) })
        }
      })
      res.on('end', () => { send({ t: 'done', id, payload: new Uint8Array() }); this.finish(id) })
      res.on('error', error => { fail(id, 'RESPONSE_ERROR', describe(error)); this.finish(id) })
    })
    req.on('error', error => { if (this.calls.get(id) === call) { fail(id, 'REQUEST_ERROR', describe(error)); this.finish(id) } })
    // A GET or HEAD body never arrives, so waiting for an `end` frame would hold the request open
    // for its whole timeout. Every other method waits for the phone to say the body is complete.
    if (method === 'GET' || method === 'HEAD') this.endCall(id)
  }

  private endCall(id: string): void {
    const call = this.calls.get(id)
    if (!call || call.ended) return
    call.ended = true
    call.req.end()
  }

  private write(id: string, payload: Uint8Array): void {
    const call = this.calls.get(id)
    if (!call || call.res || call.ended) return
    if (call.req.writableLength > 16 * 1024 * 1024) { this.cancel(id); throw new Error('Upload queue full') }
    call.req.write(Buffer.from(payload))
  }

  private cancel(id: string): void {
    const call = this.calls.get(id)
    if (call) { call.res?.destroy(); call.req.destroy(); this.finish(id) }
    const socket = this.sockets.get(id)
    if (socket) { this.socketMessages.delete(id); socket.terminate() }
  }

  private finish(id: string): void {
    const call = this.calls.get(id)
    if (!call) return
    if (call.timer) clearTimeout(call.timer)
    this.calls.delete(id)
  }

  private startSocketMessage(id: string, binary: boolean, payload: Uint8Array): void {
    if (this.sockets.get(id)?.readyState !== WebSocket.OPEN) return
    if (!payload.length || payload[0] !== 0 && payload[0] !== 1 || this.socketMessages.has(id)) { this.sockets.get(id)?.close(1002); return }
    this.appendSocketMessage(id, { binary, chunks: [], size: 0 }, payload)
  }

  private continueSocketMessage(id: string, payload: Uint8Array): void {
    const message = this.socketMessages.get(id)
    if (!message || !payload.length || payload[0] !== 0 && payload[0] !== 1) { this.sockets.get(id)?.close(1002); return }
    this.appendSocketMessage(id, message, payload)
  }

  private appendSocketMessage(id: string, message: SocketMessage, payload: Uint8Array): void {
    const end = payload[0] === 1
    const chunk = Buffer.from(payload.subarray(1))
    message.size += chunk.length
    if (message.size > MAX_SOCKET_MESSAGE) {
      this.socketMessages.delete(id)
      this.sockets.get(id)?.close(1009, 'message too large')
      return
    }
    message.chunks.push(chunk)
    if (!end) { this.socketMessages.set(id, message); return }
    this.socketMessages.delete(id)
    const socket = this.sockets.get(id)
    if (socket?.readyState === WebSocket.OPEN) socket.send(Buffer.concat(message.chunks), { binary: message.binary })
  }

  private sendSocketMessage(id: string, data: Buffer, binary: boolean, send: (frame: DirectFrame) => void): void {
    const type = binary ? 'ws.bin' : 'ws.text'
    const limit = DIRECT_MAX_FRAME - 1
    let offset = 0
    do {
      const end = Math.min(offset + limit, data.length)
      const payload = new Uint8Array(end - offset + 1)
      payload[0] = end === data.length ? 1 : 0
      payload.set(data.subarray(offset, end), 1)
      send({ t: offset === 0 ? type : 'ws.cont', id, payload })
      offset = end
    } while (offset < data.length)
  }

  private openSocket(id: string, input: Record<string, unknown>, reply: (t: DirectFrame['t'], id: string, value: unknown) => void, send: (frame: DirectFrame) => void): void {
    const path = typeof input.path === 'string' && safePath(input.path) ? input.path : undefined
    if (!path || this.sockets.has(id) || this.calls.has(id) || this.calls.size + this.sockets.size >= MAX_EXCHANGES) { reply('ws.ack', id, { ok: false, message: '直连 WebSocket 路径不合法或连接数量达到上限。' }); return }
    const port = this.options.port()
    if (!port) { reply('ws.ack', id, { ok: false, message: '本机网关未开启。' }); return }
    const protocols = Array.isArray(input.protocols) ? input.protocols.filter((item): item is string => typeof item === 'string') : []
    const host = '127.0.0.1:' + port
    const socket = new WebSocket('ws://' + host + path, protocols.length ? protocols : undefined, {
      headers: { host, origin: 'http://' + host, 'sec-fetch-site': 'same-origin', [DIRECT_MARK]: this.options.mark() },
      maxPayload: MAX_SOCKET_MESSAGE,
      perMessageDeflate: false,
      handshakeTimeout: 10_000,
    })
    this.sockets.set(id, socket)
    this.stats.sockets += 1
    let opened = false
    socket.once('open', () => {
      opened = true
      reply('ws.ack', id, { ok: true, protocol: socket.protocol })
    })
    socket.on('message', (data, binary) => this.sendSocketMessage(id, toBuffer(data), binary, send))
    socket.once('close', (code, reason) => {
      this.sockets.delete(id)
      this.socketMessages.delete(id)
      if (opened) reply('ws.close', id, { code, reason: reason.toString('utf8') })
      else reply('ws.ack', id, { ok: false, message: '网关关闭了 WebSocket 连接。' })
    })
    socket.on('error', failure => {
      if (opened) return
      reply('ws.ack', id, { ok: false, message: describe(failure) })
    })
  }

  private closeSocket(id: string, input: Record<string, unknown>): void {
    const socket = this.sockets.get(id)
    if (!socket) return
    this.socketMessages.delete(id)
    const code = typeof input.code === 'number' ? input.code : 1000
    const reason = typeof input.reason === 'string' ? input.reason : ''
    try { socket.close(closeCode(code), reason) }
    catch { socket.terminate() }
  }
}

function describe(failure: unknown): string {
  if (failure instanceof DirectFrameError) return failure.message
  const node = failure as NodeJS.ErrnoException | undefined
  return node?.code ? node.code : failure instanceof Error ? failure.message : '未知错误'
}

function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}
