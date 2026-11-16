import type { IncomingMessage, ServerResponse } from 'node:http'
import { ApiError, errorBody } from '../errors.js'

export const MAX_JSON_BODY_BYTES = 64 * 1024

const JSON_TYPE_PATTERN = /^application\/(?:[a-z0-9.+-]*\+)?json\b/iu

/** Security headers applied to every response. */
export function baseHeaders(): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? '0')
  if (Number.isFinite(declared) && declared > limit) {
    throw ApiError.payloadTooLarge('PAYLOAD_TOO_LARGE', `Request body must not exceed ${limit} bytes.`)
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buffer.byteLength
    if (total > limit) {
      throw ApiError.payloadTooLarge('PAYLOAD_TOO_LARGE', `Request body must not exceed ${limit} bytes.`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** Read and parse a JSON request body with a hard size limit. */
export async function readJsonBody(req: IncomingMessage, limit = MAX_JSON_BODY_BYTES): Promise<unknown> {
  const contentType = String(req.headers['content-type'] ?? '')
  if (!JSON_TYPE_PATTERN.test(contentType)) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.')
  }
  const body = await readBody(req, limit)
  if (body.byteLength === 0) throw ApiError.badRequest('INVALID_JSON', 'A JSON body is required.')
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw ApiError.badRequest('INVALID_JSON', 'The request body is not valid JSON.')
  }
}

export async function readRawBody(req: IncomingMessage, limit: number): Promise<Uint8Array> {
  return readBody(req, limit)
}

export interface ResponseOptions {
  head?: boolean
  cacheControl?: string
  headers?: Record<string, string>
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  options: ResponseOptions = {},
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    ...baseHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': options.cacheControl ?? 'no-store',
    'content-length': String(Buffer.byteLength(payload)),
    ...options.headers,
  })
  res.end(options.head ? undefined : payload)
}

export function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Uint8Array,
  options: ResponseOptions & { contentType: string; etag?: string },
): void {
  const headers: Record<string, string> = {
    ...baseHeaders(),
    'content-type': options.contentType,
    'cache-control': options.cacheControl ?? 'no-store',
    'content-length': String(body.byteLength),
    ...options.headers,
  }
  if (options.etag) headers.etag = options.etag
  res.writeHead(status, headers)
  res.end(options.head ? undefined : Buffer.from(body))
}

export function sendHtml(res: ServerResponse, status: number, html: string, options: ResponseOptions = {}): void {
  res.writeHead(status, {
    ...baseHeaders(),
    'content-type': 'text/html; charset=utf-8',
    'cache-control': options.cacheControl ?? 'no-store',
    'content-length': String(Buffer.byteLength(html)),
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
    ...options.headers,
  })
  res.end(options.head ? undefined : html)
}

export function sendError(res: ServerResponse, error: unknown, head = false): void {
  if (error instanceof ApiError) {
    const body = errorBody(error.code, error.message, error.retryAfterMs !== undefined ? true : undefined)
    const headers: Record<string, string> = {}
    if (error.status === 429 && error.retryAfterMs !== undefined) {
      headers['retry-after'] = String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000)))
    }
    sendJson(res, error.status, body, { head, headers })
    return
  }
  sendJson(res, 500, errorBody('INTERNAL', 'Internal server error.'), { head })
}
