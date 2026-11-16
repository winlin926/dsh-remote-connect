import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  api,
  completePairing,
  hostIdentityFromKey,
  hostRegistration,
  randomDeviceId,
  randomIdentityKey,
  registerHost,
  startNode,
} from './helpers.ts'

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

test('host registration returns a one-time credential and persists only its hash', async () => {
  const node = await startNode()
  try {
    const identityKey = randomIdentityKey()
    const registration = hostRegistration({ identityKey })
    const result = await api(node.baseUrl, 'POST', '/v1/hosts', { body: registration })
    assert.equal(result.status, 201)
    assert.match(result.json.credential, /^[A-Za-z0-9_-]{64}$/u)
    const expected = hostIdentityFromKey(identityKey)
    assert.deepEqual(result.json.host, {
      hostId: expected.hostId,
      deviceId: registration.deviceId,
      name: registration.name,
      fingerprint: expected.fingerprint,
    })
    assert.equal(result.text.includes('credential'), true)
    assert.equal(/identityKey/u.test(result.text), false, 'registration response must not echo the identity key')

    const row: any = node.app.db
      .prepare('SELECT * FROM hosts WHERE device_id = ?')
      .get(registration.deviceId)
    assert.ok(row, 'host row must be persisted')
    assert.equal(row.credential_hash, sha256Hex(result.json.credential))
    assert.notEqual(row.credential_hash, result.json.credential)
    assert.equal(row.identity_key, identityKey)

    const migrations: any[] = node.app.db.prepare('SELECT version, name FROM schema_migrations').all()
    assert.ok(migrations.some(entry => entry.version === 1))

    const plaintextLeak = node.app.db
      .prepare("SELECT COUNT(*) AS hits FROM hosts WHERE credential_hash = ? OR credential_hash LIKE ?")
      .get(result.json.credential, `%${result.json.credential}%`) as any
    assert.equal(plaintextLeak.hits, 0, 'the plaintext credential must never be stored')
  } finally {
    await node.stop()
  }
})

test('re-registering a device id or identity key fails closed', async () => {
  const node = await startNode()
  try {
    const registration = hostRegistration()
    await registerHost(node, registration)

    const sameDevice = await api(node.baseUrl, 'POST', '/v1/hosts', {
      body: hostRegistration({ deviceId: registration.deviceId }),
    })
    assert.equal(sameDevice.status, 409)
    assert.equal(sameDevice.json.error.code, 'HOST_ALREADY_REGISTERED')

    const sameIdentity = await api(node.baseUrl, 'POST', '/v1/hosts', {
      body: hostRegistration({ identityKey: registration.identityKey }),
    })
    assert.equal(sameIdentity.status, 409)
    assert.equal(sameIdentity.json.error.code, 'IDENTITY_IN_USE')

    const retry = await api(node.baseUrl, 'POST', '/v1/hosts', { body: registration })
    assert.equal(retry.status, 409, 'a Host credential is never re-issued for the same identity')
  } finally {
    await node.stop()
  }
})

test('host registration rejects hostile bodies with 4xx responses', async () => {
  const node = await startNode()
  try {
    const cases: Array<{ name: string; body?: unknown; rawBody?: string; contentType?: string; headers?: Record<string, string>; status: number; code?: string }> = [
      { name: 'missing identityKey', body: { deviceId: randomDeviceId(), name: 'h', clientVersion: '1' }, status: 400, code: 'INVALID_REQUEST' },
      { name: 'bad identityKey', body: hostRegistration({ identityKey: 'not-a-key' }), status: 400 },
      { name: 'short identityKey', body: hostRegistration({ identityKey: randomIdentityKey().slice(0, 39) }), status: 400 },
      { name: 'identityKey is not SPKI DER', body: hostRegistration({ identityKey: 'A'.repeat(59) }), status: 400, code: 'INVALID_IDENTITY_KEY' },
      { name: 'empty name', body: hostRegistration({ name: '' }), status: 400 },
      { name: 'overlong name', body: hostRegistration({ name: 'x'.repeat(200) }), status: 400 },
      { name: 'unknown field', body: { ...hostRegistration(), isAdmin: true }, status: 400 },
      { name: 'malformed json', rawBody: '{not json', contentType: 'application/json', status: 400, code: 'INVALID_JSON' },
      { name: 'wrong content type', rawBody: JSON.stringify(hostRegistration()), contentType: 'text/plain', status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
      { name: 'oversized body', body: hostRegistration({ name: 'x'.repeat(70_000) }), status: 413, code: 'PAYLOAD_TOO_LARGE' },
    ]
    for (const item of cases) {
      const result = await api(node.baseUrl, 'POST', '/v1/hosts', {
        body: item.body,
        rawBody: item.rawBody,
        contentType: item.contentType ?? (item.rawBody ? 'application/json' : undefined),
        headers: item.headers,
      })
      assert.ok(result.status < 500, `${item.name} must not cause a 500 (got ${result.status})`)
      assert.equal(result.status, item.status, `${item.name}: ${result.text}`)
      if (item.code) assert.equal(result.json.error.code, item.code)
    }
  } finally {
    await node.stop()
  }
})

test('writes from a foreign origin are rejected', async () => {
  const node = await startNode()
  try {
    const rejected = await api(node.baseUrl, 'POST', '/v1/hosts', {
      body: hostRegistration(),
      origin: 'https://evil.example',
    })
    assert.equal(rejected.status, 403)
    assert.equal(rejected.json.error.code, 'CROSS_ORIGIN_REJECTED')

    const allowed = await api(node.baseUrl, 'POST', '/v1/hosts', {
      body: hostRegistration(),
      origin: node.baseUrl,
    })
    assert.equal(allowed.status, 201)
  } finally {
    await node.stop()
  }
})

test('an optional registration token gates host registration', async () => {
  const node = await startNode({ HOST_REGISTRATION_TOKEN: 'test-registration-token' })
  try {
    const missing = await api(node.baseUrl, 'POST', '/v1/hosts', { body: hostRegistration() })
    assert.equal(missing.status, 401)
    assert.equal(missing.json.error.code, 'REGISTRATION_FORBIDDEN')

    const wrong = await api(node.baseUrl, 'POST', '/v1/hosts', {
      body: hostRegistration(),
      headers: { 'x-host-registration-token': 'wrong-token-value' },
    })
    assert.equal(wrong.status, 401)

    const accepted = await registerHost(node, hostRegistration(), 'test-registration-token')
    assert.match(accepted.credential, /^[A-Za-z0-9_-]{64}$/u)
  } finally {
    await node.stop()
  }
})

test('GET /v1/hosts requires a valid device cookie', async () => {
  const node = await startNode()
  try {
    const anonymous = await api(node.baseUrl, 'GET', '/v1/hosts')
    assert.equal(anonymous.status, 401)
    assert.equal(anonymous.json.error.code, 'AUTH_REQUIRED')

    const bogus = await api(node.baseUrl, 'GET', '/v1/hosts', { cookie: 'dsh_session=not-a-real-session-token' })
    assert.equal(bogus.status, 401)
    assert.equal(bogus.json.error.code, 'AUTH_REQUIRED')

    const malformed = await api(node.baseUrl, 'GET', '/v1/hosts', { cookie: 'dsh_session=%E0%A4%A' })
    assert.equal(malformed.status, 401, 'malformed cookies must not crash the request')
  } finally {
    await node.stop()
  }
})

test('host registration is rate limited', async () => {
  const node = await startNode()
  try {
    const statuses: number[] = []
    for (let index = 0; index < 12; index += 1) {
      const result = await api(node.baseUrl, 'POST', '/v1/hosts', { body: hostRegistration() })
      statuses.push(result.status)
      if (result.status === 429) {
        assert.equal(result.json.error.code, 'RATE_LIMITED')
        assert.ok(Number(result.headers.get('retry-after')) >= 1)
      }
    }
    assert.ok(statuses.includes(429), `expected a 429 in ${statuses.join(',')}`)
    assert.ok(statuses.filter(status => status === 201).length <= 10)
  } finally {
    await node.stop()
  }
})

test('DELETE /v1/hosts/:hostId unregisters the caller and purges its data', async () => {
  const node = await startNode()
  try {
    const paired = await completePairing(node)
    const hostId = paired.host.host.hostId
    const asset = await api(node.baseUrl, 'PUT', `/v1/assets?rev=r1&path=${encodeURIComponent('/index.html')}`, {
      token: paired.host.credential,
      rawBody: '<!doctype html><title>t</title>',
      contentType: 'text/html',
    })
    assert.equal(asset.status, 201)

    const before: any = node.app.db
      .prepare('SELECT (SELECT COUNT(*) FROM relationships) relationships, (SELECT COUNT(*) FROM device_sessions) sessions, (SELECT COUNT(*) FROM assets) assets')
      .get()
    assert.ok(Number(before.relationships) >= 1, 'pairing must leave a relationship behind')
    assert.ok(Number(before.assets) >= 1, 'the asset must be stored before the deletion')

    const removed = await api(node.baseUrl, 'DELETE', `/v1/hosts/${hostId}`, { token: paired.host.credential })
    assert.equal(removed.status, 204)

    const counts: any = node.app.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM hosts) hosts, (SELECT COUNT(*) FROM devices) devices,
                (SELECT COUNT(*) FROM relationships) relationships, (SELECT COUNT(*) FROM device_sessions) sessions,
                (SELECT COUNT(*) FROM pairing_tickets) tickets, (SELECT COUNT(*) FROM pairing_requests) requests,
                (SELECT COUNT(*) FROM assets) assets`,
      )
      .get()
    for (const table of ['hosts', 'devices', 'relationships', 'sessions', 'tickets', 'requests', 'assets'] as const) {
      assert.equal(Number(counts[table]), 0, `${table} must be empty after the host unregisters`)
    }
  } finally {
    await node.stop()
  }
})

test('a host may only unregister itself', async () => {
  const node = await startNode()
  try {
    const first = await registerHost(node, hostRegistration())
    const second = await registerHost(node, hostRegistration())
    const foreign = await api(node.baseUrl, 'DELETE', `/v1/hosts/${first.host.hostId}`, { token: second.credential })
    assert.equal(foreign.status, 403)
    assert.equal(foreign.json.error.code, 'FORBIDDEN')
    assert.ok(node.app.db.prepare('SELECT 1 FROM hosts WHERE host_id = ?').get(first.host.hostId), 'the target host must survive')
  } finally {
    await node.stop()
  }
})

test('unregistering an unknown host answers 404', async () => {
  const node = await startNode()
  try {
    const host = await registerHost(node, hostRegistration())
    const missing = await api(node.baseUrl, 'DELETE', `/v1/hosts/${'B'.repeat(43)}`, { token: host.credential })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error.code, 'HOST_NOT_FOUND')
  } finally {
    await node.stop()
  }
})

test('unregistering requires a Host credential, not a device session', async () => {
  const node = await startNode()
  try {
    const paired = await completePairing(node)
    const path = `/v1/hosts/${paired.host.host.hostId}`
    const anonymous = await api(node.baseUrl, 'DELETE', path)
    assert.equal(anonymous.status, 401)
    assert.equal(anonymous.json.error.code, 'AUTH_REQUIRED')

    const cookieOnly = await api(node.baseUrl, 'DELETE', path, { cookie: paired.cookie })
    assert.equal(cookieOnly.status, 401)
    assert.equal(cookieOnly.json.error.code, 'AUTH_REQUIRED')
  } finally {
    await node.stop()
  }
})

test('the same identity may register again after unregistering', async () => {
  const node = await startNode()
  try {
    const identityKey = randomIdentityKey()
    const registration = hostRegistration({ identityKey })
    const first = await api(node.baseUrl, 'POST', '/v1/hosts', { body: registration })
    assert.equal(first.status, 201)

    const removed = await api(node.baseUrl, 'DELETE', `/v1/hosts/${first.json.host.hostId}`, { token: first.json.credential })
    assert.equal(removed.status, 204)

    const again = await api(node.baseUrl, 'POST', '/v1/hosts', { body: registration })
    assert.equal(again.status, 201, 'a deleted registration must not block the same identity')
    assert.equal(again.json.host.hostId, first.json.host.hostId)
    assert.notEqual(again.json.credential, first.json.credential)
  } finally {
    await node.stop()
  }
})
