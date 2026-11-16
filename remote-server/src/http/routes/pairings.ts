import type { IncomingMessage } from 'node:http'
import { claimPairingSchema, createPairingSchema } from '../../contract.js'
import { ApiError, rateLimited } from '../../errors.js'
import { canonicalOrigin, serializeCookie } from '../../security.js'
import type { AppServices } from '../../services.js'
import type { Router } from '../router.js'
import { readJsonBody, sendJson } from '../util.js'

const PAIRING_TOKEN_HEADER = 'x-pairing-token'
const PAIRING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u

function pairingTokenFrom(req: IncomingMessage): string {
  const raw = req.headers[PAIRING_TOKEN_HEADER]
  const token = Array.isArray(raw) ? raw[0] : raw
  if (!token || !PAIRING_TOKEN_PATTERN.test(token)) {
    throw ApiError.unauthorized('PAIRING_TOKEN_REQUIRED', 'A pairing token header is required.')
  }
  return token
}

function sessionCookie(token: string, expiresAt: number): string {
  return serializeCookie('dsh_session', token, {
    maxAgeSeconds: Math.max(1, Math.floor((expiresAt - Date.now()) / 1_000)),
    secure: true,
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
  })
}

function cookieHeaders(cookie: { token: string; expiresAt: number } | null): Record<string, string> | undefined {
  return cookie ? { 'set-cookie': sessionCookie(cookie.token, cookie.expiresAt) } : undefined
}

/**
 * QR pairing endpoints. The phone claims a single-use ticket, then two
 * independent decisions (phone confirmation and desktop approval) gate the
 * device cookie.
 */
export function registerPairingRoutes(router: Router, services: AppServices): void {
  const { config, pairing, auth, limiter, logger } = services

  router.add('POST', '/v1/pairings', async ctx => {
    const host = auth.authenticateHostRequest(ctx.req)
    const decision = limiter.take('pairing-create', host.host_id, config.limits.pairingCreate)
    if (!decision.allowed) throw rateLimited(decision.retryAfterMs)
    let input: { ticket?: string; expiresAt?: number } = {}
    const hasBody =
      Number(ctx.req.headers['content-length'] ?? '0') > 0 ||
      ctx.req.headers['transfer-encoding'] !== undefined
    if (hasBody) {
      const parsed = createPairingSchema.safeParse(await readJsonBody(ctx.req))
      if (!parsed.success) {
        throw ApiError.badRequest('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid pairing body.')
      }
      input = parsed.data
    }
    const ticket = pairing.createTicket(host, input)
    logger.info({ event: 'pairing.ticket.created', hostId: host.host_id })
    sendJson(
      ctx.res,
      201,
      { ticket: ticket.ticket, expiresAt: ticket.expiresAt, host: pairing.hostView(host) },
      { head: ctx.head },
    )
  })

  router.add('POST', '/v1/pairings/claim', async ctx => {
    const decision = limiter.take('pairing-claim', ctx.ip, config.limits.pairingClaim)
    if (!decision.allowed) throw rateLimited(decision.retryAfterMs)
    const parsed = claimPairingSchema.safeParse(await readJsonBody(ctx.req))
    if (!parsed.success) {
      throw ApiError.badRequest('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid claim body.')
    }
    const result = pairing.claim(parsed.data)
    logger.info({ event: 'pairing.claimed', requestId: result.requestId })
    sendJson(ctx.res, 201, result, { head: ctx.head })
  })

  router.add('POST', '/v1/pairings/:requestId/confirm', ctx => {
    const token = pairingTokenFrom(ctx.req)
    const decision = limiter.take('pairing-decision', ctx.ip, config.limits.pairingDecision)
    if (!decision.allowed) throw rateLimited(decision.retryAfterMs)
    const { status, cookie } = pairing.clientConfirm(
      ctx.params.requestId ?? '',
      token,
      canonicalOrigin(ctx.req, config),
    )
    logger.info({ event: 'pairing.client_confirmed', requestId: status.requestId, complete: status.complete })
    sendJson(ctx.res, 200, status, { head: ctx.head, headers: cookieHeaders(cookie) })
  })

  router.add('POST', '/v1/pairings/:requestId/reject', ctx => {
    const token = pairingTokenFrom(ctx.req)
    const decision = limiter.take('pairing-decision', ctx.ip, config.limits.pairingDecision)
    if (!decision.allowed) throw rateLimited(decision.retryAfterMs)
    const status = pairing.clientReject(ctx.params.requestId ?? '', token)
    logger.info({ event: 'pairing.client_rejected', requestId: status.requestId })
    sendJson(ctx.res, 200, status, { head: ctx.head })
  })

  router.add('GET', '/v1/pairings/:requestId', ctx => {
    const token = pairingTokenFrom(ctx.req)
    const decision = limiter.take('pairing-poll', ctx.ip, config.limits.pairingDecision)
    if (!decision.allowed) throw rateLimited(decision.retryAfterMs)
    const { status, cookie } = pairing.poll(ctx.params.requestId ?? '', token, canonicalOrigin(ctx.req, config))
    sendJson(ctx.res, 200, status, { head: ctx.head, headers: cookieHeaders(cookie) })
  })
}
