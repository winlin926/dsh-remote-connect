/**
 * Host ↔ service-node tunnel protocol.
 *
 * The Host plugin (`src/`) and the public node (`remote-server/`) both import this module, so
 * the wire format has exactly one definition. Every WSS message is binary:
 *
 *   [4-byte big-endian JSON header length][UTF-8 JSON header][payload bytes]
 *
 * The JSON header always carries `t` (frame type). A payload is at most
 * `TUNNEL_FRAME_PAYLOAD_MAX` bytes; larger bodies are split by the sender and reassembled by
 * the receiver from the frame type alone (`http.body`/`http.chunk`/`ws.frame`).
 */
import { Buffer } from 'node:buffer'

/** The single upgrade path the node accepts Host tunnels on. */
export const TUNNEL_PATH = '/v1/tunnel'

/** Upper bound for the JSON header (defensive: real headers are a few hundred bytes). */
export const TUNNEL_FRAME_HEADER_MAX = 16 * 1024
/** Upper bound for one frame payload. */
export const TUNNEL_FRAME_PAYLOAD_MAX = 48 * 1024
/** Upper bound for one whole WSS message (used as the `ws` `maxPayload`). */
export const TUNNEL_MESSAGE_MAX = 4 + TUNNEL_FRAME_HEADER_MAX + TUNNEL_FRAME_PAYLOAD_MAX

/** Both ends send `{ t: 'ping' }` this often. */
export const TUNNEL_HEARTBEAT_INTERVAL_MS = 20_000
/** No frame of any kind for this long means the peer is gone. */
export const TUNNEL_HEARTBEAT_TIMEOUT_MS = 60_000
/** Total budget of one non-streaming HTTP request (headers + body). */
export const TUNNEL_REQUEST_TIMEOUT_MS = 120_000
/** Idle budget of a streaming response (SSE) or a WebSocket session. */
export const TUNNEL_IDLE_TIMEOUT_MS = 120_000
/** Pause reading the source direction above this much unsent data. */
export const TUNNEL_BACKPRESSURE_HIGH_WATER = 1024 * 1024
/** Resume reading once the socket drains below this. */
export const TUNNEL_BACKPRESSURE_LOW_WATER = 256 * 1024
/** A Host's Host tunnel refuses a new connection when this many requests are in flight. */
export const TUNNEL_MAX_REQUESTS_PER_HOST = 64
/** A paired device may run this many tunnel requests at once. */
export const TUNNEL_MAX_REQUESTS_PER_DEVICE = 16
/** How long the node waits for the first `hello` after the WSS handshake. */
export const TUNNEL_HELLO_TIMEOUT_MS = 10_000

export type TunnelCapability = 'http' | 'ws' | 'assets'
export type TunnelHeaderValue = string | string[]
export type TunnelHeaders = Record<string, TunnelHeaderValue>

/** Host → node, first frame of a tunnel connection. */
export interface TunnelHelloFrame {
  t: 'hello'
  hostId: string
  version: string
  capabilities: TunnelCapability[]
}

/** Node → Host: begin one proxied HTTP request. */
export interface TunnelHttpRequestFrame {
  t: 'http.request'
  id: string
  method: string
  path: string
  headers: TunnelHeaders
}
/** Node → Host: one piece of the request body, after the header frame. */
export interface TunnelHttpBodyFrame { t: 'http.body'; id: string }
/** Node → Host: the request body is complete. */
export interface TunnelHttpBodyEndFrame { t: 'http.body.end'; id: string }
/** Host → node: response header. */
export interface TunnelHttpResponseFrame {
  t: 'http.response'
  id: string
  status: number
  headers: TunnelHeaders
}
/** Host → node: one piece of the response body. */
export interface TunnelHttpChunkFrame { t: 'http.chunk'; id: string }
/** Host → node: the response is complete. */
export interface TunnelHttpEndFrame { t: 'http.end'; id: string }
/** Host → node: the response failed before it could be completed. */
export interface TunnelHttpErrorFrame { t: 'http.error'; id: string; code: string; message: string }
/** Either side: abandon request `id`. */
export interface TunnelHttpCancelFrame { t: 'http.cancel'; id: string }

/** Node → Host: upgrade one incoming WebSocket request. */
export interface TunnelWsOpenFrame {
  t: 'ws.open'
  id: string
  path: string
  headers: TunnelHeaders
  protocol?: string
}
/** Host → node: the upstream WebSocket opened (or failed). */
export interface TunnelWsAckFrame {
  t: 'ws.ack'
  id: string
  ok: boolean
  status?: number
  headers?: TunnelHeaders
  protocol?: string
  message?: string
}
/** Either side: one WebSocket message. `binary` distinguishes text from binary frames. */
export interface TunnelWsFrameFrame { t: 'ws.frame'; id: string; binary: boolean }
/** Either side: close one WebSocket. */
export interface TunnelWsCloseFrame { t: 'ws.close'; id: string; code?: number; reason?: string }

/** Either side: liveness. */
export interface TunnelPingFrame { t: 'ping'; at: number }
/** Either side: liveness answer. */
export interface TunnelPongFrame { t: 'pong'; at: number }

/** Node → Host: a device asks to pair; the Host operator must decide. */
export interface TunnelPairRequestFrame {
  t: 'pair.request'
  requestId: string
  clientDeviceId: string
  clientName: string
  clientIdentityKey: string
  verificationCode: string
  expiresAt: number
}
/** Host → node: the operator approved a pending pairing. */
export interface TunnelPairApproveFrame { t: 'pair.approve'; requestId: string }
/** Either side: the operator (or the node) rejected a pending pairing. */
export interface TunnelPairRejectFrame { t: 'pair.reject'; requestId: string }
/** Node → Host: a pairing finished; the pending entry can be dropped. */
export interface TunnelPairCompleteFrame {
  t: 'pair.complete'
  requestId: string
  clientDeviceId: string
  clientIdentityKey: string
}

export type TunnelFrame =
  | TunnelHelloFrame
  | TunnelHttpRequestFrame
  | TunnelHttpBodyFrame
  | TunnelHttpBodyEndFrame
  | TunnelHttpResponseFrame
  | TunnelHttpChunkFrame
  | TunnelHttpEndFrame
  | TunnelHttpErrorFrame
  | TunnelHttpCancelFrame
  | TunnelWsOpenFrame
  | TunnelWsAckFrame
  | TunnelWsFrameFrame
  | TunnelWsCloseFrame
  | TunnelPingFrame
  | TunnelPongFrame
  | TunnelPairRequestFrame
  | TunnelPairApproveFrame
  | TunnelPairRejectFrame
  | TunnelPairCompleteFrame

export type TunnelFrameType = TunnelFrame['t']

/** Frames a Host may send to a node. */
export const HOST_TO_NODE_FRAME_TYPES: ReadonlySet<TunnelFrameType> = new Set([
  'hello',
  'http.response',
  'http.chunk',
  'http.end',
  'http.error',
  'http.cancel',
  'ws.ack',
  'ws.frame',
  'ws.close',
  'ping',
  'pong',
  'pair.approve',
  'pair.reject',
])

export type TunnelFrameErrorCode = 'FRAME_TOO_LARGE' | 'FRAME_INVALID'

/** A malformed or oversized tunnel frame. The caller normally closes the tunnel. */
export class TunnelFrameError extends Error {
  readonly code: TunnelFrameErrorCode

  constructor(code: TunnelFrameErrorCode, message: string) {
    super(message)
    this.name = 'TunnelFrameError'
    this.code = code
  }
}

export interface DecodedTunnelFrame {
  frame: TunnelFrame
  payload: Uint8Array
}

const EMPTY = new Uint8Array(0)

/** Encode one frame. Oversized headers or payloads are rejected, never truncated. */
export function encodeTunnelFrame(frame: TunnelFrame, payload: Uint8Array = EMPTY): Buffer {
  if (payload.byteLength > TUNNEL_FRAME_PAYLOAD_MAX) {
    throw new TunnelFrameError('FRAME_TOO_LARGE', '隧道帧负载超过上限。')
  }
  const header = Buffer.from(JSON.stringify(frame), 'utf8')
  if (header.byteLength > TUNNEL_FRAME_HEADER_MAX) {
    throw new TunnelFrameError('FRAME_TOO_LARGE', '隧道帧头超过上限。')
  }
  const output = Buffer.allocUnsafe(4 + header.byteLength + payload.byteLength)
  output.writeUInt32BE(header.byteLength, 0)
  header.copy(output, 4)
  output.set(payload, 4 + header.byteLength)
  return output
}

/** Decode one full WSS message. Throws `TunnelFrameError` on anything malformed. */
export function decodeTunnelFrame(data: Uint8Array): DecodedTunnelFrame {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (bytes.byteLength < 4) throw new TunnelFrameError('FRAME_INVALID', '隧道帧不完整。')
  const headerLength = bytes.readUInt32BE(0)
  if (headerLength === 0) throw new TunnelFrameError('FRAME_INVALID', '隧道帧头为空。')
  if (headerLength > TUNNEL_FRAME_HEADER_MAX) throw new TunnelFrameError('FRAME_TOO_LARGE', '隧道帧头超过上限。')
  if (bytes.byteLength < 4 + headerLength) throw new TunnelFrameError('FRAME_INVALID', '隧道帧不完整。')
  const payload = bytes.subarray(4 + headerLength)
  if (payload.byteLength > TUNNEL_FRAME_PAYLOAD_MAX) throw new TunnelFrameError('FRAME_TOO_LARGE', '隧道帧负载超过上限。')
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.subarray(4, 4 + headerLength).toString('utf8'))
  } catch {
    throw new TunnelFrameError('FRAME_INVALID', '隧道帧头不是 JSON。')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TunnelFrameError('FRAME_INVALID', '隧道帧头不是对象。')
  }
  const type = (parsed as { t?: unknown }).t
  if (typeof type !== 'string' || type.length === 0) throw new TunnelFrameError('FRAME_INVALID', '隧道帧缺少类型。')
  return { frame: parsed as TunnelFrame, payload: payload as Uint8Array }
}

/** Split a body chunk into frame-sized payload slices; an empty chunk produces no frames. */
export function splitTunnelPayload(data: Uint8Array): Uint8Array[] {
  if (data.byteLength === 0) return []
  if (data.byteLength <= TUNNEL_FRAME_PAYLOAD_MAX) return [data]
  const slices: Uint8Array[] = []
  for (let offset = 0; offset < data.byteLength; offset += TUNNEL_FRAME_PAYLOAD_MAX) {
    slices.push(data.subarray(offset, Math.min(offset + TUNNEL_FRAME_PAYLOAD_MAX, data.byteLength)))
  }
  return slices
}

/** Copy a Node header record into the JSON-safe tunnel shape (numbers become strings). */
export function toTunnelHeaders(headers: Record<string, string | string[] | number | undefined>): TunnelHeaders {
  const output: TunnelHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') output[name] = value
    else if (typeof value === 'number') output[name] = String(value)
    else if (Array.isArray(value)) output[name] = [...value]
  }
  return output
}

/** Validate headers decoded from a frame; anything unexpected is dropped (never trusted). */
export function asTunnelHeaders(value: unknown): TunnelHeaders {
  const output: TunnelHeaders = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return output
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') output[name] = entry
    else if (Array.isArray(entry) && entry.every(item => typeof item === 'string')) output[name] = [...entry] as string[]
  }
  return output
}
