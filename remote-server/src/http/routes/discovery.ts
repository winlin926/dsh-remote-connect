import { parseNodeDescriptor } from '../../contract.js'
import { EMPTY_FINGERPRINT, EMPTY_HOST_ID } from '../../identity.js'
import type { AppServices } from '../../services.js'
import type { Router } from '../router.js'
import { sendJson } from '../util.js'

/**
 * Public discovery surface. `hostId`/`fingerprint` describe the node's primary
 * Host identity (the first Host registered on this deployment); before any Host
 * registers they are format-valid placeholders so the contract shape never
 * changes.
 */
export function registerDiscoveryRoutes(router: Router, services: AppServices): void {
  const { config, repos } = services

  router.add('GET', '/.well-known/dsh-remote', ctx => {
    const host = repos.findFirstHost()
    const descriptor = parseNodeDescriptor({
      protocol: 1,
      kind: 'service',
      name: config.nodeName,
      version: config.nodeVersion,
      capabilities: config.capabilities,
      hostId: host?.host_id ?? EMPTY_HOST_ID,
      fingerprint: host?.fingerprint ?? EMPTY_FINGERPRINT,
    })
    sendJson(ctx.res, 200, descriptor, { head: ctx.head, cacheControl: 'no-store' })
  })

  router.add('GET', '/healthz', ctx => {
    sendJson(ctx.res, 200, { ok: true, version: config.nodeVersion }, { head: ctx.head })
  })

  router.add('GET', '/v1/config', ctx => {
    sendJson(
      ctx.res,
      200,
      {
        protocol: 1,
        kind: 'service',
        name: config.nodeName,
        version: config.nodeVersion,
        capabilities: config.capabilities,
      },
      { head: ctx.head, cacheControl: 'no-store' },
    )
  })
}
