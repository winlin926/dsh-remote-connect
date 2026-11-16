import { ApiError } from '../../errors.js'
import type { AppServices } from '../../services.js'
import type { Router } from '../router.js'
import { sendJson } from '../util.js'

/** TURN time-limited credentials (coturn `use-auth-secret`). */
export function registerTurnRoutes(router: Router, services: AppServices): void {
  const { auth, turn, logger } = services

  router.add('GET', '/v1/turn-credentials', ctx => {
    const session = auth.requireSession(ctx.req)
    if (!turn.enabled) {
      throw ApiError.notImplemented(
        'TURN_NOT_CONFIGURED',
        'This node does not provide TURN relay. Configure TURN_URLS and TURN_SECRET to enable it.',
      )
    }
    const credentials = turn.credentials(session.device.device_id)
    logger.info({ event: 'turn.credentials.issued', deviceId: session.device.device_id })
    sendJson(ctx.res, 200, credentials, { head: ctx.head })
  })
}
