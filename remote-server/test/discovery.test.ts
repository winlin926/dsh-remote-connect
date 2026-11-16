import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nodeDescriptorSchema } from '../dist/remote-server/src/contract.js'
import {
  api,
  hostIdentityFromKey,
  hostRegistration,
  randomIdentityKey,
  registerHost,
  startNode,
} from './helpers.ts'

test('well-known descriptor matches the node contract exactly', async () => {
  const node = await startNode()
  try {
    const result = await api(node.baseUrl, 'GET', '/.well-known/dsh-remote')
    assert.equal(result.status, 200)
    assert.equal(result.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.equal(result.headers.get('cache-control'), 'no-store')
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff')

    const parsed = nodeDescriptorSchema.safeParse(result.json)
    assert.equal(parsed.success, true, 'well-known body must satisfy the strict node descriptor schema')

    assert.equal(result.json.protocol, 1)
    assert.equal(result.json.kind, 'service')
    assert.equal(result.json.name, '我的公网节点')
    assert.equal(result.json.version, '0.6.0')
    assert.ok(Array.isArray(result.json.capabilities))
    assert.ok(result.json.capabilities.includes('pairing'))
    for (const capability of result.json.capabilities) {
      assert.ok(['pairing', 'cache', 'official-ui', 'relay', 'turn'].includes(capability))
    }
    assert.match(result.json.hostId, /^[A-Za-z0-9_-]{43}$/u)
    assert.match(result.json.fingerprint, /^[0-9a-f]{32}$/u)
    assert.equal(Object.keys(result.json).sort().join(','), 'capabilities,fingerprint,hostId,kind,name,protocol,version')
    assert.equal(/credential|secret|token|private/i.test(result.text), false, 'discovery must not leak secrets')
  } finally {
    await node.stop()
  }
})

test('well-known host identity is derived from the registered Host public key', async () => {
  const node = await startNode({ NODE_NAME: '自建节点-测试', NODE_VERSION: '9.9.9' })
  try {
    const identityKey = randomIdentityKey()
    const registration = hostRegistration({ identityKey })
    await registerHost(node, registration)

    const expected = hostIdentityFromKey(identityKey)
    const result = await api(node.baseUrl, 'GET', '/.well-known/dsh-remote')
    assert.equal(result.status, 200)
    assert.equal(result.json.name, '自建节点-测试')
    assert.equal(result.json.version, '9.9.9')
    assert.equal(result.json.hostId, expected.hostId, 'hostId = base64url(sha256(X25519 SPKI DER)), 43 chars')
    assert.equal(result.json.fingerprint, expected.fingerprint, 'fingerprint = first 16 bytes of the same sha256, lowercase hex')
    assert.equal(expected.hostId.length, 43)
    assert.equal(expected.fingerprint.length, 32)
  } finally {
    await node.stop()
  }
})

test('healthz and /v1/config stay minimal', async () => {
  const node = await startNode()
  try {
    const health = await api(node.baseUrl, 'GET', '/healthz')
    assert.equal(health.status, 200)
    assert.deepEqual(health.json, { ok: true, version: '0.6.0' })

    const config = await api(node.baseUrl, 'GET', '/v1/config')
    assert.equal(config.status, 200)
    assert.equal(config.json.protocol, 1)
    assert.equal(config.json.kind, 'service')
    assert.equal(Object.keys(config.json).sort().join(','), 'capabilities,kind,name,protocol,version')
    assert.equal(config.json.hostId, undefined, '/v1/config must not expose host identity')
    assert.equal(config.json.fingerprint, undefined)
    assert.equal(config.headers.get('cache-control'), 'no-store')
  } finally {
    await node.stop()
  }
})

test('node descriptor schema rejects a wrong protocol, kind, capability or identity', () => {
  const valid = {
    protocol: 1,
    kind: 'service',
    name: '我的公网节点',
    version: '0.6.0',
    capabilities: ['pairing', 'relay'],
    hostId: 'A'.repeat(43),
    fingerprint: '0'.repeat(32),
  }
  assert.equal(nodeDescriptorSchema.safeParse(valid).success, true)
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, protocol: 2 }).success, false)
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, protocol: '1' }).success, false)
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, kind: 'gateway' }).success, true, 'gateway is a valid contract kind')
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, kind: 'peer' }).success, false)
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, capabilities: ['cache'] }).success, false, 'pairing is required')
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, capabilities: ['pairing', 'relay', 'telepathy'] }).success, false)
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, capabilities: ['pairing', 'pairing'] }).success, false)
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, hostId: 'short' }).success, false)
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, fingerprint: 'A'.repeat(32) }).success, false)
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, extra: true }).success, false, 'descriptor is strict')
})

test('unknown paths return a JSON 404 and wrong methods return 405, never 500', async () => {
  const node = await startNode()
  try {
    const missing = await api(node.baseUrl, 'GET', '/v1/does-not-exist')
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error.code, 'NOT_FOUND')
    assert.equal(missing.headers.get('content-type'), 'application/json; charset=utf-8')

    const wrongMethod = await api(node.baseUrl, 'POST', '/healthz', { body: {} })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.json.error.code, 'METHOD_NOT_ALLOWED')
  } finally {
    await node.stop()
  }
})

test('HEAD requests are served without a body and the landing page is self-contained', async () => {
  const node = await startNode()
  try {
    const head = await api(node.baseUrl, 'HEAD', '/.well-known/dsh-remote')
    assert.equal(head.status, 200)
    assert.equal(head.text, '')
    assert.ok(Number(head.headers.get('content-length')) > 0)

    for (const path of ['/', '/pair']) {
      const page = await api(node.baseUrl, 'GET', path)
      assert.equal(page.status, 200)
      assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
      assert.equal(page.headers.get('cache-control'), 'no-store')
      assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/u)
      assert.match(page.text, /DSH Remote/u)
    }
  } finally {
    await node.stop()
  }
})

test('invalid configuration fails fast instead of silently degrading', async () => {
  await assert.rejects(
    () => startNode({ CAPABILITIES: 'cache' }),
    (error: any) => error?.name === 'ConfigError' && /pairing/u.test(error.message),
  )
  await assert.rejects(
    () => startNode({ CAPABILITIES: 'pairing,turn' }),
    (error: any) => error?.name === 'ConfigError' && /TURN/u.test(error.message),
  )
  await assert.rejects(
    () => startNode({ PAIRING_TICKET_TTL_SECONDS: '600' }),
    (error: any) => error?.name === 'ConfigError',
  )
})
