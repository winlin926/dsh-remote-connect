import { createHmac } from 'node:crypto'
import type { TurnConfig } from './config.js'

export interface TurnCredentials {
  urls: string[]
  username: string
  credential: string
  expiresAt: number
  ttlSeconds: number
}

/**
 * coturn REST credentials: username `<expiry>:<deviceId>` plus
 * base64(HMAC-SHA1(secret, username)). The shared secret never leaves the
 * server process.
 */
export class TurnService {
  constructor(private readonly turn: TurnConfig | null) {}

  get enabled(): boolean {
    return this.turn !== null
  }

  credentials(deviceId: string, now = Date.now()): TurnCredentials {
    const turn = this.turn
    if (!turn) throw new Error('TURN is not configured')
    const expiresAt = Math.floor(now / 1_000) + turn.ttlSeconds
    const username = `${expiresAt}:${deviceId}`
    const credential = createHmac('sha1', turn.secret).update(username).digest('base64')
    return { urls: turn.urls, username, credential, expiresAt, ttlSeconds: turn.ttlSeconds }
  }
}
