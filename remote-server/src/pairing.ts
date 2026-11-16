import type { Config } from './config.js'
import { ApiError } from './errors.js'
import {
  createToken,
  decodeCanonicalBase64Url,
  decodeIdentityKey,
  hashToken,
  newRequestId,
  pairingVerificationCode,
} from './identity.js'
import {
  constantTimeStringEqual,
} from './identity.js'
import type { TunnelFrame } from '../../src/remote/tunnel-protocol.js'
import type { HostRow, PairingRequestRow, Repositories } from './repositories.js'
import type { SessionService } from './sessions.js'

/** Events pushed to the live tunnel; implemented by the tunnel hub. */
export interface PairingNotifier {
  isHostOnline(hostId: string): boolean
  sendToHost(hostId: string, frame: TunnelFrame): boolean
}

export interface PairingHostView {
  name: string
  hostId: string
  fingerprint: string
}

export interface ClaimResult {
  requestId: string
  pairingToken: string
  host: PairingHostView
  verificationCode: string
  expiresAt: number
}

export interface PairingStatus {
  requestId: string
  state: PairingRequestRow['state']
  host: PairingHostView
  clientDeviceId: string
  expiresAt: number
  complete: boolean
}

export interface IssuedCookie {
  token: string
  expiresAt: number
}

const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/u

/**
 * QR pairing state machine. Two independent decisions (phone confirmation and
 * desktop approval) must both land before a device cookie is issued; a ticket
 * authorizes at most one pairing attempt and is consumed atomically.
 */
export class PairingService {
  private registry: PairingNotifier | null = null

  constructor(
    private readonly repos: Repositories,
    private readonly config: Config,
    private readonly sessions: SessionService,
    private readonly clock: () => number = Date.now,
  ) {}

  attach(registry: PairingNotifier): void {
    this.registry = registry
  }

  private notifier(): PairingNotifier {
    if (!this.registry) throw new Error('PairingService is not attached to the tunnel hub')
    return this.registry
  }

  hostView(host: HostRow): PairingHostView {
    return { name: host.name, hostId: host.host_id, fingerprint: host.fingerprint }
  }

  /** Host generates or forwards a single-use ticket (valid for at most 5 minutes). */
  createTicket(host: HostRow, input: { ticket?: string; expiresAt?: number }): { ticket: string; expiresAt: number } {
    const now = this.clock()
    let ticket: string
    if (input.ticket === undefined) {
      ticket = createToken(32).token
    } else {
      ticket = input.ticket
      if (!TICKET_PATTERN.test(ticket) || decodeCanonicalBase64Url(ticket, 32) === null) {
        throw ApiError.badRequest('INVALID_TICKET', 'ticket must be 32 random bytes encoded as base64url.')
      }
    }
    let expiresAt = input.expiresAt ?? now + this.config.pairingTicketTtlMs
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
      throw ApiError.badRequest('INVALID_TICKET', 'expiresAt must be in the future.')
    }
    if (expiresAt > now + this.config.pairingTicketTtlMs) {
      expiresAt = now + this.config.pairingTicketTtlMs
    }
    this.repos.insertTicket({ ticketHash: hashToken(ticket), hostId: host.host_id, expiresAt, createdAt: now })
    return { ticket, expiresAt }
  }

  claim(input: {
    ticket: string
    client: { deviceId: string; name: string; platform: string; identityKey: string }
  }): ClaimResult {
    const now = this.clock()
    if (decodeIdentityKey(input.client.identityKey) === null) {
      throw ApiError.badRequest('INVALID_IDENTITY_KEY', 'client.identityKey must be a Base64URL-encoded SPKI DER public key.')
    }
    const ticketHash = hashToken(input.ticket)
    const ticket = this.repos.findTicket(ticketHash)
    if (!ticket) throw ApiError.notFound('TICKET_INVALID', 'The pairing ticket is not valid.')
    if (ticket.expires_at <= now) throw ApiError.gone('TICKET_EXPIRED', 'The pairing ticket has expired.')
    if (ticket.request_id !== null) throw ApiError.conflict('TICKET_USED', 'The pairing ticket was already used.')
    const host = this.repos.findHostById(ticket.host_id)
    if (!host) throw ApiError.notFound('TICKET_INVALID', 'The pairing ticket is not valid.')

    const existingDevice = this.repos.findDevice(input.client.deviceId)
    if (existingDevice && existingDevice.identity_key !== input.client.identityKey) {
      throw ApiError.conflict('DEVICE_IDENTITY_MISMATCH', 'This device id is already bound to another identity key.')
    }
    const existingRelationship = this.repos.findRelationship(host.host_id, input.client.deviceId)
    if (
      existingRelationship &&
      existingRelationship.revoked_at === null &&
      existingRelationship.client_identity_key !== input.client.identityKey
    ) {
      throw ApiError.conflict('DEVICE_IDENTITY_MISMATCH', 'This device is already paired with a different identity key.')
    }
    if (!this.notifier().isHostOnline(host.host_id)) {
      throw ApiError.conflict('HOST_OFFLINE', 'The Host is not connected to this relay right now.')
    }

    const requestId = newRequestId()
    const pairingToken = createToken(32).token
    const expiresAt = Math.min(ticket.expires_at, now + this.config.pairingTicketTtlMs)
    const verificationCode = pairingVerificationCode(input.ticket, host.identity_key, input.client.identityKey)
    const consumed = this.repos.transaction(() => {
      this.repos.insertPairingRequest({
        requestId,
        hostId: host.host_id,
        ticketHash,
        clientDeviceId: input.client.deviceId,
        clientName: input.client.name,
        clientPlatform: input.client.platform,
        clientIdentityKey: input.client.identityKey,
        claimTokenHash: hashToken(pairingToken),
        expiresAt,
        createdAt: now,
      })
      return this.repos.consumeTicket(ticketHash, requestId)
    })
    if (!consumed) throw ApiError.conflict('TICKET_USED', 'The pairing ticket was already used.')

    this.push(host.host_id, {
      t: 'pair.request',
      requestId,
      clientDeviceId: input.client.deviceId,
      clientName: input.client.name,
      clientIdentityKey: input.client.identityKey,
      verificationCode,
      expiresAt,
    })

    return { requestId, pairingToken, host: this.hostView(host), verificationCode, expiresAt }
  }

  /** Phone-side decision. */
  clientConfirm(requestId: string, pairingToken: string, origin: string): {
    status: PairingStatus
    cookie: IssuedCookie | null
  } {
    const request = this.requireRequestForClient(requestId, pairingToken)
    const now = this.clock()
    this.assertOpen(request, now)
    if (request.state === 'pending') {
      this.repos.advancePairing(requestId, ['pending'], 'client_approved', 'client_confirmed_at', now)
    } else if (request.state === 'host_approved') {
      this.complete(request, now)
    }
    return this.statusWithCookie(requestId, origin, now)
  }

  /** Phone-side rejection. */
  clientReject(requestId: string, pairingToken: string): PairingStatus {
    const request = this.requireRequestForClient(requestId, pairingToken)
    if (request.state !== 'complete') this.repos.setPairingRejected(requestId)
    return this.status(requestId)
  }

  /** Desktop-side decision, driven by a `pair.approve` / `pair.reject` frame. */
  hostDecision(host: HostRow, requestId: string, approve: boolean): PairingStatus {
    const request = this.repos.findPairingRequest(requestId)
    if (!request || request.host_id !== host.host_id) {
      throw ApiError.notFound('PAIRING_NOT_FOUND', 'The pairing request is not available for this Host.')
    }
    const now = this.clock()
    if (request.state === 'rejected') throw ApiError.conflict('PAIRING_REJECTED', 'The pairing request was rejected.')
    if (!approve) {
      if (request.state !== 'complete') this.repos.setPairingRejected(requestId)
      this.push(host.host_id, { t: 'pair.reject', requestId })
      return this.status(requestId)
    }
    this.assertOpen(request, now)
    if (request.state === 'pending') {
      this.repos.advancePairing(requestId, ['pending'], 'host_approved', 'host_confirmed_at', now)
    } else if (request.state === 'client_approved') {
      this.complete(request, now)
      this.push(host.host_id, {
        t: 'pair.complete',
        requestId,
        clientDeviceId: request.client_device_id,
        clientIdentityKey: request.client_identity_key,
      })
    }
    return this.status(requestId)
  }

  /** Poll for the browser while the desktop decides. */
  poll(requestId: string, pairingToken: string, origin: string): {
    status: PairingStatus
    cookie: IssuedCookie | null
  } {
    const request = this.requireRequestForClient(requestId, pairingToken)
    return this.statusWithCookie(request.request_id, origin, this.clock())
  }

  private statusWithCookie(
    requestId: string,
    origin: string,
    now: number,
  ): { status: PairingStatus; cookie: IssuedCookie | null } {
    const status = this.status(requestId)
    if (!status.complete) return { status, cookie: null }
    if (!this.repos.claimCookieIssuance(requestId, now)) return { status, cookie: null }
    const request = this.repos.findPairingRequest(requestId)
    if (!request) return { status, cookie: null }
    const cookie = this.sessions.issue(request.client_device_id, origin, now)
    return { status, cookie }
  }

  status(requestId: string): PairingStatus {
    const request = this.repos.findPairingRequest(requestId)
    if (!request) throw ApiError.notFound('PAIRING_NOT_FOUND', 'The pairing request is not valid.')
    const host = this.repos.findHostById(request.host_id)
    if (!host) throw ApiError.notFound('PAIRING_NOT_FOUND', 'The pairing request is not valid.')
    return {
      requestId: request.request_id,
      state: request.state,
      host: this.hostView(host),
      clientDeviceId: request.client_device_id,
      expiresAt: request.expires_at,
      complete: request.state === 'complete',
    }
  }

  /** Complete pairing exactly once, then materialize device + relationship. */
  private complete(request: PairingRequestRow, now: number): void {
    this.repos.transaction(() => {
      const advanced = this.repos.advancePairing(
        request.request_id,
        ['host_approved', 'client_approved'],
        'complete',
        'completed_at',
        now,
      )
      if (!advanced) return
      this.repos.upsertDevice({
        deviceId: request.client_device_id,
        name: request.client_name,
        platform: request.client_platform,
        identityKey: request.client_identity_key,
        now,
      })
      this.repos.upsertRelationship({
        hostId: request.host_id,
        clientDeviceId: request.client_device_id,
        clientIdentityKey: request.client_identity_key,
        now,
      })
    })
  }

  private requireRequestForClient(requestId: string, pairingToken: string): PairingRequestRow {
    const request = this.repos.findPairingRequest(requestId)
    if (!request) throw ApiError.notFound('PAIRING_NOT_FOUND', 'The pairing request is not valid.')
    if (!constantTimeStringEqual(hashToken(pairingToken), request.claim_token_hash)) {
      throw ApiError.unauthorized('PAIRING_TOKEN_INVALID', 'The pairing token is not valid.')
    }
    return request
  }

  private assertOpen(request: PairingRequestRow, now: number): void {
    if (request.state === 'rejected') throw ApiError.gone('PAIRING_REJECTED', 'The pairing request was rejected.')
    if (request.expires_at <= now && request.state !== 'complete') {
      throw ApiError.gone('PAIRING_EXPIRED', 'The pairing request has expired.')
    }
  }

  private push(hostId: string, frame: TunnelFrame): void {
    this.notifier().sendToHost(hostId, frame)
  }

  /** Delete long-expired pairing material. */
  sweep(): number {
    return this.repos.sweepPairing(this.clock())
  }
}
