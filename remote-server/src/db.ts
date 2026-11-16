import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

interface Migration {
  version: number
  name: string
  statements: string[]
}

/**
 * Versioned, idempotent schema. Every statement must be safe to re-run, so an
 * interrupted migration can never leave the database in an unusable shape.
 * Credentials, cookies and pairing tickets are only ever stored as SHA-256
 * hashes; the tables below never hold a private key or a plaintext secret.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    statements: [
      `CREATE TABLE IF NOT EXISTS hosts (
        host_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        identity_key TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL,
        client_version TEXT NOT NULL,
        credential_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS pairing_tickets (
        ticket_hash TEXT PRIMARY KEY,
        host_id TEXT NOT NULL REFERENCES hosts(host_id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        request_id TEXT
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS pairing_tickets_request_idx
        ON pairing_tickets(request_id) WHERE request_id IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS pairing_requests (
        request_id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL REFERENCES hosts(host_id) ON DELETE CASCADE,
        ticket_hash TEXT NOT NULL UNIQUE REFERENCES pairing_tickets(ticket_hash) ON DELETE CASCADE,
        client_device_id TEXT NOT NULL,
        client_name TEXT NOT NULL,
        client_platform TEXT NOT NULL,
        client_identity_key TEXT NOT NULL,
        claim_token_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'client_approved', 'host_approved', 'complete', 'rejected')),
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        client_confirmed_at INTEGER,
        host_confirmed_at INTEGER,
        completed_at INTEGER,
        cookie_issued_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS pairing_requests_host_idx ON pairing_requests(host_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS relationships (
        host_id TEXT NOT NULL REFERENCES hosts(host_id) ON DELETE CASCADE,
        client_device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
        client_identity_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        PRIMARY KEY (host_id, client_device_id)
      )`,
      `CREATE INDEX IF NOT EXISTS relationships_device_idx ON relationships(client_device_id)`,
      `CREATE TABLE IF NOT EXISTS device_sessions (
        credential_hash TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
        bound_origin TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        expires_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS device_sessions_device_idx ON device_sessions(device_id)`,
      `CREATE TABLE IF NOT EXISTS assets (
        host_id TEXT NOT NULL REFERENCES hosts(host_id) ON DELETE CASCADE,
        revision TEXT NOT NULL,
        path TEXT NOT NULL,
        content_type TEXT NOT NULL,
        etag TEXT NOT NULL,
        size INTEGER NOT NULL,
        content BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (host_id, revision, path)
      )`,
    ],
  },
]

export class Database {
  readonly sqlite: DatabaseSync
  private readonly statements = new Map<string, StatementSync>()

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.sqlite = new DatabaseSync(path)
    this.sqlite.exec('PRAGMA busy_timeout = 5000')
    this.sqlite.exec('PRAGMA foreign_keys = ON')
    if (path !== ':memory:') this.sqlite.exec('PRAGMA journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.sqlite.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`)
    const applied = this.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>
    const versions = new Set(applied.map(row => Number(row.version)))
    for (const migration of MIGRATIONS) {
      if (versions.has(migration.version)) continue
      this.sqlite.exec('BEGIN IMMEDIATE')
      try {
        for (const statement of migration.statements) this.sqlite.exec(statement)
        this.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, Date.now())
        this.sqlite.exec('COMMIT')
      } catch (error) {
        this.sqlite.exec('ROLLBACK')
        throw error
      }
    }
  }

  prepare(sql: string): StatementSync {
    const cached = this.statements.get(sql)
    if (cached) return cached
    const statement = this.sqlite.prepare(sql)
    this.statements.set(sql, statement)
    return statement
  }

  /** Run `fn` inside an immediate transaction; rolling back on any throw. */
  transaction<T>(fn: () => T): T {
    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.sqlite.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.sqlite.exec('ROLLBACK')
      } catch {
        // The transaction is already gone; rethrow the original failure.
      }
      throw error
    }
  }

  close(): void {
    this.statements.clear()
    this.sqlite.close()
  }
}

export function openDatabase(path: string): Database {
  return new Database(path)
}
