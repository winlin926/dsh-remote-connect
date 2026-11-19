import { request as httpRequest } from 'node:http'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { connect as netConnect } from 'node:net'
import type { Duplex } from 'node:stream'
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

/** Headers a frame may not control: they describe this hop, not the phone's request. */
const BLOCKED = new Set([
  'host', 'cookie', 'authorization', 'origin', 'referer', 'connection', 'upgrade', 'keep-alive',
  'transfer-encoding', 'content-length', 'accept-encoding', 'sec-fetch-site', 'sec-websocket-key',
  'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol', 'te', 'trailer',
  'proxy-authorization', 'proxy-connection', 'upgrade-insecure-requests',
])

interface HttpCall { req: ClientRequest; res?: IncomingMessage; timer?: ReturnType<typeof setTimeout> }

/**
 * One direct connection's traffic, carried as frames and replayed against the computer's own
 * gateway over loopback. Nothing here decides who may connect: the gateway does that, from the
 * mark this class stamps, so a direct request is authorized by exactly the rules a remote one is.
 */
export class DirectBridge {
  private readonly calls = new Map<string, HttpCall>()
  private readonly sockets = new Map<string, Duplex>()
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
        this.stats.received += data.length
        let frame: DirectFrame
        try { frame = decodeDirectFrame(data) } catch (failure) { this.options.log?.('直连帧被拒绝：' + describe(failure)); return }
        switch (frame.t) {
          case 'ping': reply('pong', frame.id, readControl(frame)); return
          case 'pong': return
          case 'open': this.open(frame.id, readControl(frame), send, fail); return
          case 'body': this.write(frame.id, frame.payload); return
          case 'end': this.calls.get(frame.id)?.req.end(); return
          case 'cancel': this.cancel(frame.id); return
          case 'ws.open': void this.openSocket(frame.id, readControl(frame), reply, send); return
          case 'ws.text': this.sockets.get(frame.id)?.write(Buffer.from(frame.payload).toString('utf8')); return
          case 'ws.bin': this.sockets.get(frame.id)?.write(Buffer.from(frame.payload)); return
          case 'ws.close': this.closeSocket(frame.id, readControl(frame)); return
          default: return
        }
      },
      dispose: (): void => {
        this.disposed = true
        for (const id of [...this.calls.keys()]) this.cancel(id)
        for (const id of [...this.sockets.keys()]) this.sockets.get(id)?.destroy()
        this.sockets.clear()
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
    if (this.calls.has(id)) { fail(id, 'DUPLICATE', '该请求已存在。'); return }
    const method = typeof input.method === 'string' ? input.method.toUpperCase() : 'GET'
    const path = typeof input.path === 'string' && input.path.startsWith('/') ? input.path : undefined
    if (!path) { fail(id, 'BAD_PATH', '直连请求路径不合法。'); return }
    const port = this.options.port()
    if (!port) { fail(id, 'NO_GATEWAY', '本机网关未开启。'); return }
    this.stats.requests += 1
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: this.headers(input, port) })
    const call: HttpCall = { req }
    this.calls.set(id, call)
    call.timer = setTimeout(() => { this.finish(id); fail(id, 'TIMEOUT', '直连请求超时。') }, this.options.requestTimeoutMs ?? DIRECT_REQUEST_TIMEOUT_MS)
    if (call.timer.unref) call.timer.unref()
    req.on('response', res => {
      call.res = res
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
    req.on('error', error => { fail(id, 'REQUEST_ERROR', describe(error)); this.finish(id) })
  }

  private write(id: string, payload: Uint8Array): void {
    const call = this.calls.get(id)
    if (!call || call.res) return
    call.req.write(Buffer.from(payload))
  }

  private cancel(id: string): void {
    const call = this.calls.get(id)
    if (call) { call.res?.destroy(); call.req.destroy(); this.finish(id) }
    const socket = this.sockets.get(id)
    if (socket) { this.sockets.delete(id); socket.destroy() }
  }

  private finish(id: string): void {
    const call = this.calls.get(id)
    if (!call) return
    if (call.timer) clearTimeout(call.timer)
    this.calls.delete(id)
  }

  private async openSocket(id: string, input: Record<string, unknown>, reply: (t: DirectFrame['t'], id: string, value: unknown) => void, send: (frame: DirectFrame) => void): Promise<void> {
    const path = typeof input.path === 'string' && input.path.startsWith('/') ? input.path : undefined
    if (!path) { reply('ws.ack', id, { ok: false, message: '直连 WebSocket 路径不合法。' }); return }
    const port = this.options.port()
    if (!port) { reply('ws.ack', id, { ok: false, message: '本机网关未开启。' }); return }
    const protocols = Array.isArray(input.protocols) ? input.protocols.filter((item): item is string => typeof item === 'string') : undefined
    // A WebSocket upgrade is the one request the gateway's HTTP handler cannot carry, so this hop
    // performs the handshake itself with the same envelope the bridge stamps on plain requests.
    const key = Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString('base64')
    const headers = ['GET ' + path + ' HTTP/1.1', 'Host: 127.0.0.1:' + port, 'Upgrade: websocket', 'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + key, 'Sec-WebSocket-Version: 13', 'Origin: http://127.0.0.1:' + port,
      'Sec-Fetch-Site: same-origin', DIRECT_MARK + ': ' + this.options.mark()]
    if (protocols?.length) headers.push('Sec-WebSocket-Protocol: ' + protocols.join(', '))
    const socket = netConnect({ host: '127.0.0.1', port })
    this.sockets.set(id, socket)
    this.stats.sockets += 1
    let buffer = Buffer.alloc(0)
    const settle = (value: boolean, message?: string): void => {
      socket.removeAllListeners('data')
      socket.removeAllListeners('error')
      socket.removeAllListeners('connect')
      if (!value) { this.sockets.delete(id); socket.destroy(); reply('ws.ack', id, { ok: false, message }); return }
      reply('ws.ack', id, { ok: true, ...(protocols?.length ? { protocol: protocols[0] } : {}) })
      socket.on('data', (chunk: Buffer) => {
        for (let offset = 0; offset < chunk.length; offset += DIRECT_MAX_FRAME) {
          send({ t: 'ws.bin', id, payload: new Uint8Array(chunk.subarray(offset, offset + DIRECT_MAX_FRAME)) })
        }
      })
      socket.on('error', () => { send({ t: 'ws.close', id, payload: controlPayload({ code: 1011 }) }); this.sockets.delete(id) })
      socket.on('close', () => { this.sockets.delete(id); send({ t: 'ws.close', id, payload: controlPayload({ code: 1000 }) }) })
    }
    socket.on('error', error => settle(false, describe(error)))
    socket.on('close', () => { if (this.sockets.has(id)) { this.sockets.delete(id); reply('ws.ack', id, { ok: false, message: '网关关闭了连接。' }) } })
    socket.once('connect', () => socket.write(headers.join('\r\n') + '\r\n\r\n'))
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0 || !this.sockets.has(id)) return
      const head = buffer.subarray(0, end).toString('utf8').split('\r\n')
      const status = Number((head[0] ?? '').split(' ')[1])
      const rest = buffer.subarray(end + 4)
      if (status !== 101) { settle(false, '网关拒绝了直连 WebSocket（HTTP ' + status + '）。'); return }
      settle(true)
      if (rest.length) send({ t: 'ws.bin', id, payload: new Uint8Array(rest) })
    })
  }

  private closeSocket(id: string, input: Record<string, unknown>): void {
    const socket = this.sockets.get(id)
    if (!socket) return
    this.sockets.delete(id)
    try {
      const code = typeof input.code === 'number' ? input.code : 1000
      const payload = Buffer.alloc(2); payload.writeUInt16BE(code)
      if (typeof input.reason === 'string' && input.reason) socket.write(Buffer.concat([Buffer.from([0x88, payload.length + input.reason.length]), payload, Buffer.from(input.reason, 'utf8')]))
      else socket.write(Buffer.from([0x88, 2, payload[0]!, payload[1]!]))
    } catch { /* a socket already gone needs no frame */ }
    socket.end()
  }
}

function describe(failure: unknown): string {
  if (failure instanceof DirectFrameError) return failure.message
  const node = failure as NodeJS.ErrnoException | undefined
  return node?.code ? node.code : failure instanceof Error ? failure.message : '未知错误'
}
