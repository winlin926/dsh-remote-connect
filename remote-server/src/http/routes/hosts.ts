import { hostRegistrationSchema } from '../../contract.js'
import { ApiError, rateLimited } from '../../errors.js'
import {
  createToken,
  deriveHostIdentity,
  hashToken,
} from '../../identity.js'
import type { AppServices } from '../../services.js'
import type { RouteContext, Router } from '../router.js'
import { baseHeaders, readJsonBody, sendJson } from '../util.js'

/**
 * Host lifecycle: registration returns an opaque credential (only its hash is
 * stored) and device relationships are scoped to the caller's cookie. There is
 * no registration token: `POST /v1/hosts` is open, rate limited, and grants no
 * access beyond the newly created Host's own credential.
 */
export function registerHostRoutes(router: Router, services: AppServices): void {
  const { config, repos, sessions, auth, limiter, tunnelProxy, logger } = services

  router.add('POST', '/v1/hosts', async ctx => {
    const decision = limiter.take('host-registration', ctx.ip, config.limits.hostRegistration)
    if (!decision.allowed) throw rateLimited(decision.retryAfterMs)
    const body = await readJsonBody(ctx.req)
    const parsed = hostRegistrationSchema.safeParse(body)
    if (!parsed.success) {
      throw ApiError.badRequest('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid Host registration body.')
    }
    const { deviceId, name, identityKey, clientVersion } = parsed.data
    // Throws 400 INVALID_IDENTITY_KEY when the DER is not a valid SPKI public key.
    const identity = deriveHostIdentity(identityKey)
    const existing = repos.findHostByDeviceId(deviceId)
    if (existing) throw ApiError.conflict('HOST_ALREADY_REGISTERED', 'This device id is already registered.')
    if (repos.findHostByIdentityKey(identityKey)) {
      throw ApiError.conflict('IDENTITY_IN_USE', 'This identity key is already registered.')
    }
    const credential = createToken(48)
    try {
      repos.insertHost({
        hostId: identity.hostId,
        deviceId,
        name,
        identityKey,
        fingerprint: identity.fingerprint,
        clientVersion,
        credentialHash: hashToken(credential.token),
        createdAt: Date.now(),
      })
    } catch {
      throw ApiError.conflict('HOST_ALREADY_REGISTERED', 'This Host is already registered.')
    }
    logger.info({ event: 'host.registered', hostId: identity.hostId, deviceId })
    sendJson(
      ctx.res,
      201,
      {
        credential: credential.token,
        host: { hostId: identity.hostId, deviceId, name, fingerprint: identity.fingerprint },
      },
      { head: ctx.head },
    )
  })

  router.add('GET', '/v1/hosts', ctx => {
    const context = auth.requireSession(ctx.req)
    const rows = repos.listRelationshipsForDevice(context.device.device_id)
    const hosts = rows.flatMap(relationship => {
      const host = repos.findHostById(relationship.host_id)
      if (!host) return []
      return [
        {
          hostId: host.host_id,
          deviceId: host.device_id,
          name: host.name,
          fingerprint: host.fingerprint,
          pairedAt: relationship.created_at,
          status: 'active' as const,
        },
      ]
    })
    sendJson(ctx.res, 200, { hosts }, { head: ctx.head })
  })

  router.add('DELETE', '/v1/hosts/:hostId/devices/:deviceId', async ctx => {
    const context = auth.requireSession(ctx.req)
    const hostId = ctx.params.hostId ?? ''
    const deviceId = ctx.params.deviceId ?? ''
    if (deviceId !== context.device.device_id) {
      throw ApiError.forbidden('FORBIDDEN', 'A device may only revoke its own relationship.')
    }
    const host = repos.findHostById(hostId)
    if (!host) throw ApiError.notFound('HOST_NOT_FOUND', 'The Host is not registered on this node.')
    const relationship = repos.findRelationship(hostId, deviceId)
    if (!relationship || relationship.revoked_at !== null) {
      throw ApiError.notFound('RELATIONSHIP_NOT_FOUND', 'There is no active pairing with this Host.')
    }
    repos.revokeRelationship(hostId, deviceId, Date.now())
    sessions.revokeDevice(deviceId)
    tunnelProxy.closeDevice(deviceId)
    logger.info({ event: 'relationship.revoked', hostId, deviceId })
    sendJson(ctx.res, 200, { ok: true, hostId, deviceId }, { head: ctx.head })
  })

  // A Host may delete its own registration. This is the counterpart of "remove this computer" in the
  // plugin: without it the node would keep the row and reject a later registration of the same host.
  router.add('DELETE', '/v1/hosts/:hostId', async ctx => {
    const caller = auth.authenticateHostRequest(ctx.req)
    const hostId = ctx.params.hostId ?? ''
    const target = repos.findHostById(hostId)
    if (!target) throw ApiError.notFound('HOST_NOT_FOUND', 'The Host is not registered on this node.')
    if (caller.host_id !== hostId) throw ApiError.forbidden('FORBIDDEN', 'A Host may only unregister itself.')
    const deleted = repos.deleteHost(hostId)
    logger.info({ event: 'host.unregistered', hostId, ...deleted })
    ctx.res.writeHead(204, baseHeaders())
    ctx.res.end()
  })
}
