/**
 * The wire format of one direct (WebRTC DataChannel) connection between a paired phone and this
 * computer. It is deliberately the smallest thing that can carry the Host's ordinary HTTP and
 * WebSocket traffic: the phone speaks its normal requests, the computer answers with its normal
 * responses, and nothing above this layer learns that the public entry was not used.
 *
 * A frame is one DataChannel message:
 *   byte 0      frame type
 *   bytes 1-2   big-endian id length (0 for connection-level frames)
 *   bytes 3..   id (ASCII)
 *   rest        payload: UTF-8 JSON for control frames, raw bytes for body frames
 *
 * 16 KiB is the largest payload this side ever sends, so no peer has to fragment SCTP.
 */

export const DIRECT_PROTOCOL = 1
/** Same-origin route the phone posts its offer to and polls for the answer. */
export const DIRECT_SIGNAL_PATH = '/rc/direct/signal'
/** Set by the bridge on every loopback request it makes; the gateway resolves it to a device. */
export const DIRECT_MARK = 'x-dsh-direct'
/** Largest payload carried by one frame. */
export const DIRECT_MAX_FRAME = 16 * 1024
/** A request that the phone stops reading may not hold the channel forever. */
export const DIRECT_REQUEST_TIMEOUT_MS = 120_000
/** How long an unanswered offer stays usable. */
export const DIRECT_SIGNAL_TTL_MS = 60_000
/** One channel that says nothing for this long is considered gone. */
export const DIRECT_IDLE_TIMEOUT_MS = 90_000

export type DirectFrameType =
  | 'open' | 'body' | 'end' | 'result' | 'chunk' | 'done' | 'fail' | 'cancel'
  | 'ws.open' | 'ws.ack' | 'ws.text' | 'ws.bin' | 'ws.close'
  | 'ping' | 'pong' | 'hello'

const TYPES: DirectFrameType[] = [
  'open', 'body', 'end', 'result', 'chunk', 'done', 'fail', 'cancel',
  'ws.open', 'ws.ack', 'ws.text', 'ws.bin', 'ws.close',
  'ping', 'pong', 'hello',
]
const CODES = new Map<DirectFrameType, number>(TYPES.map((type, index) => [type, index + 1]))
const NAMES = new Map<number, DirectFrameType>(TYPES.map((type, index) => [index + 1, type]))

export interface DirectFrame {
  t: DirectFrameType
  id: string
  /** Raw bytes, or the UTF-8 bytes of the control frame's JSON. */
  payload: Uint8Array
}

export class DirectFrameError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'DirectFrameError' }
}

const ID = /^[A-Za-z0-9_-]{1,64}$/

export function encodeDirectFrame(frame: DirectFrame): Uint8Array {
  const code = CODES.get(frame.t)
  if (code === undefined) throw new DirectFrameError('UNKNOWN_TYPE', '未知的直连帧类型。')
  if (!ID.test(frame.id)) throw new DirectFrameError('BAD_ID', '直连帧的 id 不合法。')
  if (frame.payload.length > DIRECT_MAX_FRAME) throw new DirectFrameError('FRAME_TOO_LARGE', '直连帧超过大小上限。')
  const id = Buffer.from(frame.id, 'ascii')
  const out = new Uint8Array(3 + id.length + frame.payload.length)
  out[0] = code
  out[1] = id.length >> 8
  out[2] = id.length & 0xff
  out.set(id, 3)
  out.set(frame.payload, 3 + id.length)
  return out
}

export function decodeDirectFrame(bytes: Uint8Array): DirectFrame {
  if (bytes.length < 3) throw new DirectFrameError('FRAME_INVALID', '直连帧过短。')
  const t = NAMES.get(bytes[0]!)
  if (!t) throw new DirectFrameError('UNKNOWN_TYPE', '未知的直连帧类型。')
  const length = (bytes[1]! << 8) | bytes[2]!
  if (length < 0 || length > 64 || bytes.length < 3 + length) throw new DirectFrameError('FRAME_INVALID', '直连帧的 id 长度不合法。')
  const id = Buffer.from(bytes.subarray(3, 3 + length)).toString('ascii')
  if (!ID.test(id)) throw new DirectFrameError('BAD_ID', '直连帧的 id 不合法。')
  const payload = bytes.subarray(3 + length)
  if (payload.length > DIRECT_MAX_FRAME) throw new DirectFrameError('FRAME_TOO_LARGE', '直连帧超过大小上限。')
  return { t, id, payload }
}

export function controlPayload(value: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify(value), 'utf8'))
}

export function readControl(frame: DirectFrame): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(frame.payload).toString('utf8') || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return value as Record<string, unknown>
  } catch { return {} }
}

/** A new opaque id for one request or socket on the channel. */
export function directId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}
