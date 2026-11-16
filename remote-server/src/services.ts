import type { AssetService } from './assets.js'
import type { AuthService } from './auth.js'
import type { Config } from './config.js'
import type { Database } from './db.js'
import type { Logger } from './logger.js'
import type { PairingService } from './pairing.js'
import type { RateLimiter } from './rate-limit.js'
import type { Repositories } from './repositories.js'
import type { SessionService } from './sessions.js'
import type { TurnService } from './turn.js'
import type { ControlHub } from './wss/hub.js'

/** Everything an HTTP route or the WSS hub needs, assembled once in `app.ts`. */
export interface AppServices {
  config: Config
  logger: Logger
  db: Database
  repos: Repositories
  sessions: SessionService
  auth: AuthService
  pairing: PairingService
  assets: AssetService
  turn: TurnService
  limiter: RateLimiter
  hub: ControlHub
}
