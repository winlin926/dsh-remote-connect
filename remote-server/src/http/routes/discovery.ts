import { parseNodeDescriptor } from '../../contract.js'
import type { AppServices } from '../../services.js'
import type { Router } from '../router.js'
import { sendJson } from '../util.js'

/**
 * Public discovery surface. The `node` block comes from the persisted node
 * identity, so it is available before the first Host ever registers and never
 * changes when Hosts register, unregister or are deleted.
 */
export function registerDiscoveryRoutes(router: Router, services: AppServices): void {
  const { config, nodeIdentity } = services
  const node = {
    id: nodeIdentity.nodeId,
    fingerprint: nodeIdentity.fingerprint,
    publicKey: nodeIdentity.publicKey,
  }

  router.add('GET', '/.well-known/dsh-remote', ctx => {
    const descriptor = parseNodeDescriptor({
      protocol: 2,
      kind: 'service',
      name: config.nodeName,
      version: config.nodeVersion,
      capabilities: config.capabilities,
      node,
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
        protocol: 2,
        kind: 'service',
        name: config.nodeName,
        version: config.nodeVersion,
        capabilities: config.capabilities,
        node,
      },
      { head: ctx.head, cacheControl: 'no-store' },
    )
  })
}
