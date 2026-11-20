import type { Database } from './db.js'

export interface HostRow {
  host_id: string
  device_id: string
  name: string
  identity_key: string
  fingerprint: string
  client_version: string
  credential_hash: string
  created_at: number
  last_seen_at: number | null
}

export interface PairingTicketRow {
  ticket_hash: string
  host_id: string
  expires_at: number
  created_at: number
  request_id: string | null
}

export type PairingState = 'pending' | 'client_approved' | 'host_approved' | 'complete' | 'rejected'

export interface PairingRequestRow {
  request_id: string
  host_id: string
  ticket_hash: string
  client_device_id: string
  client_name: string
  client_platform: string
  client_identity_key: string
  claim_token_hash: string
  state: PairingState
  expires_at: number
  created_at: number
  client_confirmed_at: number | null
  host_confirmed_at: number | null
  completed_at: number | null
  cookie_issued_at: number | null
}

/** Rows removed when one Host is deleted; zero for tables that held nothing for it. */
export interface HostDeletionCounts {
  hosts: number
  devices: number
  relationships: number
  sessions: number
  tickets: number
  requests: number
  assets: number
}

export interface DeviceRow {
  device_id: string
  name: string
  platform: string
  identity_key: string
  created_at: number
  last_seen_at: number | null
}

export interface RelationshipRow {
  host_id: string
  client_device_id: string
  client_identity_key: string
  created_at: number
  revoked_at: number | null
}

export interface DeviceSessionRow {
  credential_hash: string
  device_id: string
  bound_origin: string
  bound_host_id: string | null
  created_at: number
  last_seen_at: number | null
  expires_at: number
}

export interface AssetRow {
  host_id: string
  revision: string
  path: string
  content_type: string
  etag: string
  size: number
  content: Uint8Array
  created_at: number
}

/** Typed persistence layer over `node:sqlite`; every statement is prepared once. */
export class Repositories {
  constructor(private readonly db: Database) {}

  /** Run `fn` inside an immediate transaction (see `Database.transaction`). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)
  }

  // ---------------------------------------------------------------- hosts

  insertHost(host: {
    hostId: string
    deviceId: string
    name: string
    identityKey: string
    fingerprint: string
    clientVersion: string
    credentialHash: string
    createdAt: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO hosts (host_id, device_id, name, identity_key, fingerprint, client_version, credential_hash, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        host.hostId,
        host.deviceId,
        host.name,
        host.identityKey,
        host.fingerprint,
        host.clientVersion,
        host.credentialHash,
        host.createdAt,
      )
  }

  findHostByDeviceId(deviceId: string): HostRow | undefined {
    return this.db.prepare('SELECT * FROM hosts WHERE device_id = ?').get(deviceId) as HostRow | undefined
  }

  findHostByIdentityKey(identityKey: string): HostRow | undefined {
    return this.db.prepare('SELECT * FROM hosts WHERE identity_key = ?').get(identityKey) as HostRow | undefined
  }

  findHostById(hostId: string): HostRow | undefined {
    return this.db.prepare('SELECT * FROM hosts WHERE host_id = ?').get(hostId) as HostRow | undefined
  }

  findHostByCredentialHash(credentialHash: string): HostRow | undefined {
    return this.db
      .prepare('SELECT * FROM hosts WHERE credential_hash = ?')
      .get(credentialHash) as HostRow | undefined
  }

  touchHost(hostId: string, now: number): void {
    this.db.prepare('UPDATE hosts SET last_seen_at = ? WHERE host_id = ?').run(now, hostId)
  }

  /**
   * Delete one Host and every row scoped to it: pairing material, assets and the authorizations it
   * issued, plus the sessions of the devices that were paired with it. A device that still has a
   * relationship with another Host is kept.
   */
  deleteHost(hostId: string): HostDeletionCounts {
    return this.transaction(() => {
      const devices = this.db
        .prepare('SELECT client_device_id FROM relationships WHERE host_id = ?')
        .all(hostId) as unknown as Array<{ client_device_id: string }>
      let sessions = 0
      for (const device of devices) {
        sessions += Number(
          this.db.prepare('DELETE FROM device_sessions WHERE device_id = ?').run(device.client_device_id).changes,
        )
      }
      const relationships = Number(this.db.prepare('DELETE FROM relationships WHERE host_id = ?').run(hostId).changes)
      let removedDevices = 0
      for (const device of devices) {
        removedDevices += Number(
          this.db
            .prepare(
              'DELETE FROM devices WHERE device_id = ? AND NOT EXISTS (SELECT 1 FROM relationships WHERE client_device_id = ?)',
            )
            .run(device.client_device_id, device.client_device_id).changes,
        )
      }
      const requests = Number(this.db.prepare('DELETE FROM pairing_requests WHERE host_id = ?').run(hostId).changes)
      const tickets = Number(this.db.prepare('DELETE FROM pairing_tickets WHERE host_id = ?').run(hostId).changes)
      const assets = Number(this.db.prepare('DELETE FROM assets WHERE host_id = ?').run(hostId).changes)
      const hosts = Number(this.db.prepare('DELETE FROM hosts WHERE host_id = ?').run(hostId).changes)
      return { hosts, devices: removedDevices, relationships, sessions, tickets, requests, assets }
    })
  }

  // -------------------------------------------------------------- tickets

  insertTicket(ticket: { ticketHash: string; hostId: string; expiresAt: number; createdAt: number }): void {
    this.db
      .prepare(
        'INSERT INTO pairing_tickets (ticket_hash, host_id, expires_at, created_at, request_id) VALUES (?, ?, ?, ?, NULL)',
      )
      .run(ticket.ticketHash, ticket.hostId, ticket.expiresAt, ticket.createdAt)
  }

  findTicket(ticketHash: string): PairingTicketRow | undefined {
    return this.db.prepare('SELECT * FROM pairing_tickets WHERE ticket_hash = ?').get(ticketHash) as
      | PairingTicketRow
      | undefined
  }

  /** Atomically mark a ticket as consumed; returns false when already used. */
  consumeTicket(ticketHash: string, requestId: string): boolean {
    const result = this.db
      .prepare('UPDATE pairing_tickets SET request_id = ? WHERE ticket_hash = ? AND request_id IS NULL')
      .run(requestId, ticketHash)
    return Number(result.changes) === 1
  }

  /** Delete long-expired pairing material. */
  sweepPairing(now: number): number {
    const tickets = this.db
      .prepare('DELETE FROM pairing_tickets WHERE expires_at < ? AND request_id IS NULL')
      .run(now - 60_000)
    const requests = this.db
      .prepare("DELETE FROM pairing_requests WHERE expires_at < ? AND state IN ('pending', 'client_approved', 'host_approved')")
      .run(now - 60_000)
    return Number(tickets.changes) + Number(requests.changes)
  }

  // ----------------------------------------------------- pairing requests

  insertPairingRequest(request: {
    requestId: string
    hostId: string
    ticketHash: string
    clientDeviceId: string
    clientName: string
    clientPlatform: string
    clientIdentityKey: string
    claimTokenHash: string
    expiresAt: number
    createdAt: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO pairing_requests (request_id, host_id, ticket_hash, client_device_id, client_name,
           client_platform, client_identity_key, claim_token_hash, state, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        request.requestId,
        request.hostId,
        request.ticketHash,
        request.clientDeviceId,
        request.clientName,
        request.clientPlatform,
        request.clientIdentityKey,
        request.claimTokenHash,
        request.expiresAt,
        request.createdAt,
      )
  }

  findPairingRequest(requestId: string): PairingRequestRow | undefined {
    return this.db.prepare('SELECT * FROM pairing_requests WHERE request_id = ?').get(requestId) as
      | PairingRequestRow
      | undefined
  }

  findPairingRequestByTicket(ticketHash: string): PairingRequestRow | undefined {
    return this.db.prepare('SELECT * FROM pairing_requests WHERE ticket_hash = ?').get(ticketHash) as
      | PairingRequestRow
      | undefined
  }

  /**
   * Advance a pairing decision with a single conditional UPDATE so concurrent
   * client/host confirmations can never both create a session. Returns the
   * fresh row after the transition, or undefined when the state did not match.
   */
  advancePairing(
    requestId: string,
    from: PairingState[],
    to: PairingState,
    column: 'client_confirmed_at' | 'host_confirmed_at' | 'completed_at',
    now: number,
  ): PairingRequestRow | undefined {
    const placeholders = from.map(() => '?').join(', ')
    const result = this.db
      .prepare(
        `UPDATE pairing_requests SET state = ?, ${column} = ? WHERE request_id = ? AND state IN (${placeholders})`,
      )
      .run(to, now, requestId, ...from)
    if (Number(result.changes) !== 1) return undefined
    return this.findPairingRequest(requestId)
  }

  /** Atomically claim the single cookie issuance for a completed pairing. */
  claimCookieIssuance(requestId: string, now: number): boolean {
    const result = this.db
      .prepare(
        "UPDATE pairing_requests SET cookie_issued_at = ? WHERE request_id = ? AND cookie_issued_at IS NULL AND state = 'complete'",
      )
      .run(now, requestId)
    return Number(result.changes) === 1
  }

  setPairingRejected(requestId: string): void {
    this.db
      .prepare("UPDATE pairing_requests SET state = 'rejected' WHERE request_id = ? AND state != 'complete'")
      .run(requestId)
  }

  // -------------------------------------------------------------- devices

  upsertDevice(device: { deviceId: string; name: string; platform: string; identityKey: string; now: number }): void {
    this.db
      .prepare(
        `INSERT INTO devices (device_id, name, platform, identity_key, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           name = excluded.name,
           platform = excluded.platform,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(device.deviceId, device.name, device.platform, device.identityKey, device.now, device.now)
  }

  findDevice(deviceId: string): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId) as DeviceRow | undefined
  }

  touchDevice(deviceId: string, now: number): void {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE device_id = ?').run(now, deviceId)
  }

  // -------------------------------------------------------- relationships

  upsertRelationship(relationship: {
    hostId: string
    clientDeviceId: string
    clientIdentityKey: string
    now: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO relationships (host_id, client_device_id, client_identity_key, created_at, revoked_at)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(host_id, client_device_id) DO UPDATE SET
           client_identity_key = excluded.client_identity_key,
           revoked_at = NULL`,
      )
      .run(relationship.hostId, relationship.clientDeviceId, relationship.clientIdentityKey, relationship.now)
  }

  findRelationship(hostId: string, clientDeviceId: string): RelationshipRow | undefined {
    return this.db
      .prepare('SELECT * FROM relationships WHERE host_id = ? AND client_device_id = ?')
      .get(hostId, clientDeviceId) as RelationshipRow | undefined
  }

  listRelationshipsForDevice(clientDeviceId: string): RelationshipRow[] {
    return this.db
      .prepare('SELECT * FROM relationships WHERE client_device_id = ? AND revoked_at IS NULL ORDER BY created_at DESC')
      .all(clientDeviceId) as unknown as RelationshipRow[]
  }

  listRevokedDevices(hostId: string): string[] {
    return (this.db.prepare('SELECT client_device_id FROM relationships WHERE host_id = ? AND revoked_at IS NOT NULL').all(hostId) as Pick<RelationshipRow, 'client_device_id'>[])
      .map(row => row.client_device_id)
  }

  revokeRelationship(hostId: string, clientDeviceId: string, now: number): void {
    this.db
      .prepare(
        'UPDATE relationships SET revoked_at = ? WHERE host_id = ? AND client_device_id = ? AND revoked_at IS NULL',
      )
      .run(now, hostId, clientDeviceId)
  }

  // ------------------------------------------------------------- sessions

  insertSession(session: {
    credentialHash: string
    deviceId: string
    boundOrigin: string
    hostId: string
    now: number
    expiresAt: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO device_sessions (credential_hash, device_id, bound_origin, bound_host_id, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(session.credentialHash, session.deviceId, session.boundOrigin, session.hostId, session.now, session.now, session.expiresAt)
  }

  findSession(credentialHash: string): DeviceSessionRow | undefined {
    return this.db
      .prepare('SELECT * FROM device_sessions WHERE credential_hash = ?')
      .get(credentialHash) as DeviceSessionRow | undefined
  }

  touchSession(credentialHash: string, now: number): void {
    this.db.prepare('UPDATE device_sessions SET last_seen_at = ? WHERE credential_hash = ?').run(now, credentialHash)
  }

  deleteSession(credentialHash: string): void {
    this.db.prepare('DELETE FROM device_sessions WHERE credential_hash = ?').run(credentialHash)
  }

  /** Revocation kills every browser session of the device. */
  deleteSessionsForDevice(deviceId: string): void {
    this.db.prepare('DELETE FROM device_sessions WHERE device_id = ?').run(deviceId)
  }

  // --------------------------------------------------------------- assets

  upsertAsset(asset: {
    hostId: string
    revision: string
    path: string
    contentType: string
    etag: string
    size: number
    content: Uint8Array
    now: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO assets (host_id, revision, path, content_type, etag, size, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(host_id, revision, path) DO UPDATE SET
           content_type = excluded.content_type,
           etag = excluded.etag,
           size = excluded.size,
           content = excluded.content,
           created_at = excluded.created_at`,
      )
      .run(
        asset.hostId,
        asset.revision,
        asset.path,
        asset.contentType,
        asset.etag,
        asset.size,
        asset.content,
        asset.now,
      )
  }

  findAsset(hostId: string, revision: string, path: string): AssetRow | undefined {
    return this.db
      .prepare('SELECT * FROM assets WHERE host_id = ? AND revision = ? AND path = ?')
      .get(hostId, revision, path) as AssetRow | undefined
  }
}
