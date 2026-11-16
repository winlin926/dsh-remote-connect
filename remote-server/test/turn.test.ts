import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConfigError, loadConfig } from '../dist/remote-server/src/config.js'
import { api, completePairing, startNode, turnCredential } from './helpers.ts'

const TURN_SECRET = 'test-turn-shared-secret-0123456789'

test('a node without TURN answers 501 with a configuration hint', async () => {
  const node = await startNode()
  const paired = await completePairing(node)
  try {
    const unauthenticated = await api(node.baseUrl, 'GET', '/v1/turn-credentials')
    assert.equal(unauthenticated.status, 401)
    assert.equal(unauthenticated.json.error.code, 'AUTH_REQUIRED')

    const cookie = `${paired.cookieParts.name}=${paired.cookieParts.value}`
    const response = await api(node.baseUrl, 'GET', '/v1/turn-credentials', { cookie })
    assert.equal(response.status, 501)
    assert.equal(response.json.error.code, 'TURN_NOT_CONFIGURED')
    assert.match(response.json.error.message, /TURN_URLS/u)
    assert.match(response.json.error.message, /TURN_SECRET/u)
  } finally {
    paired.hostClient.close()
    await node.stop()
  }
})

test('a node with TURN issues coturn REST credentials bound to the device', async () => {
  const node = await startNode({
    TURN_URLS: 'turn:127.0.0.1:3478?transport=udp,turns:127.0.0.1:5349?transport=tcp',
    TURN_SECRET,
    TURN_TTL_SECONDS: '600',
  })
  const paired = await completePairing(node)
  try {
    const cookie = `${paired.cookieParts.name}=${paired.cookieParts.value}`
    const before = Math.floor(Date.now() / 1_000)
    const response = await api(node.baseUrl, 'GET', '/v1/turn-credentials', { cookie })
    assert.equal(response.status, 200)
    assert.deepEqual(response.json.urls, ['turn:127.0.0.1:3478?transport=udp', 'turns:127.0.0.1:5349?transport=tcp'])
    assert.equal(response.json.ttlSeconds, 600)
    assert.ok(response.json.expiresAt >= before + 600)
    assert.ok(response.json.expiresAt <= Math.floor(Date.now() / 1_000) + 600)
    assert.equal(response.json.username, `${response.json.expiresAt}:${paired.client.deviceId}`)
    assert.equal(response.json.credential, turnCredential(TURN_SECRET, response.json.username))
    assert.notEqual(response.json.credential, TURN_SECRET)

    const config = await api(node.baseUrl, 'GET', '/v1/config')
    assert.deepEqual(config.json.capabilities, ['pairing', 'cache', 'official-ui'])
    assert.ok(!config.json.capabilities.includes('turn'), '0.6.2 never advertises TURN')
    const wellKnown = await api(node.baseUrl, 'GET', '/.well-known/dsh-remote')
    assert.deepEqual(wellKnown.json.capabilities, ['pairing', 'cache', 'official-ui'])
    assert.deepEqual(node.app.config.capabilities, ['pairing', 'cache', 'official-ui'])
  } finally {
    paired.hostClient.close()
    await node.stop()
  }
})

test('invalid TURN configuration fails closed at startup', () => {
  const base = { NODE_NAME: '节点', DATA_DIR: './data' }
  assert.throws(
    () => loadConfig({ ...base, TURN_URLS: 'turn:127.0.0.1:3478' }),
    (error: unknown) => error instanceof ConfigError,
  )
  assert.throws(
    () => loadConfig({ ...base, TURN_URLS: 'turn:127.0.0.1:3478', TURN_SECRET: 'short' }),
    (error: unknown) => error instanceof ConfigError,
  )
  assert.throws(
    () => loadConfig({ ...base, TURN_URLS: 'https://127.0.0.1:3478', TURN_SECRET }),
    (error: unknown) => error instanceof ConfigError,
  )
  assert.throws(
    () => loadConfig({ ...base, CAPABILITIES: 'pairing,turn' }),
    (error: unknown) => error instanceof ConfigError,
  )
  const valid = loadConfig({ ...base, TURN_URLS: 'turn:127.0.0.1:3478', TURN_SECRET })
  assert.deepEqual(valid.turn?.urls, ['turn:127.0.0.1:3478'])
  assert.deepEqual(valid.capabilities, ['pairing', 'cache', 'official-ui'], 'TURN config never changes the advertised set')
  assert.throws(
    () => loadConfig({ ...base, TURN_URLS: 'turn:127.0.0.1:3478', TURN_SECRET, CAPABILITIES: 'pairing,turn' }),
    (error: unknown) => error instanceof ConfigError,
    '0.6.2 refuses to advertise turn even when TURN is configured',
  )
})
