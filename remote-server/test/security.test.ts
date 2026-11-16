import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import WebSocket from 'ws'
import {
  api,
  connectControl,
  hostHello,
  hostRegistration,
  rawRequest,
  registerHost,
  startNode,
} from './helpers.ts'

test('cross-origin writes are rejected and same-origin writes pass', async () => {
  const node = await startNode()
  try {
    const registration = hostRegistration()
    const foreign = await api(node.baseUrl, 'POST', '/v1/hosts', {
      body: registration,
      origin: 'https://evil.example',
    })
    assert.equal(foreign.status, 403)
    assert.equal(foreign.json.error.code, 'CROSS_ORIGIN_REJECTED')

    const sameOrigin = await api(node.baseUrl, 'POST', '/v1/hosts', {
      body: hostRegistration(),
      origin: node.baseUrl,
    })
    assert.equal(sameOrigin.status, 201)

    const readOnly = await api(node.baseUrl, 'GET', '/healthz', { origin: 'https://evil.example' })
    assert.equal(readOnly.status, 200, 'cross-origin reads are not blocked, they simply expose no CORS headers')
    assert.equal(readOnly.headers.get('access-control-allow-origin'), null)
  } finally {
    await node.stop()
  }
})

test('ALLOWED_ORIGINS extends the set of accepted write origins', async () => {
  const node = await startNode({ ALLOWED_ORIGINS: 'https://app.example, https://alt.example' })
  try {
    const allowed = await api(node.baseUrl, 'POST', '/v1/hosts', {
      body: hostRegistration(),
      origin: 'https://app.example',
    })
    assert.equal(allowed.status, 201)
    const denied = await api(node.baseUrl, 'POST', '/v1/hosts', {
      body: hostRegistration(),
      origin: 'https://other.example',
    })
    assert.equal(denied.status, 403)
  } finally {
    await node.stop()
  }
})

test('PUBLIC_ORIGIN pins the canonical origin and the device cookie origin', async () => {
  const publicOrigin = 'https://relay.example'
  const node = await startNode({ PUBLIC_ORIGIN: publicOrigin })
  try {
    const mismatch = await api(node.baseUrl, 'POST', '/v1/hosts', {
      body: hostRegistration(),
      origin: 'https://elsewhere.example',
    })
    assert.equal(mismatch.status, 403)

    const host = await registerHost(node, hostRegistration())
    const ticket = await api(node.baseUrl, 'POST', '/v1/pairings', { token: host.credential })
    assert.equal(ticket.status, 201)
    const PairingService = (await import('../dist/remote-server/src/pairing.js')).PairingService
    const service = new PairingService(node.app.services.repos, node.app.config, node.app.services.sessions, Date.now)
    service.attach({
      isHostOnline: () => true,
      sendToHost: () => true,
      sendToDevice: () => true,
      closeDeviceSessions: () => undefined,
      closeHostConnections: () => undefined,
    })
    const hostRow = node.app.services.repos.findHostByDeviceId(host.registration.deviceId)
    const client = {
      deviceId: randomUUID(),
      name: '手机',
      platform: 'ios',
      identityKey: hostRegistration().identityKey as string,
    }
    const claim = service.claim({ ticket: ticket.json.ticket, client })
    service.clientConfirm(claim.requestId, claim.pairingToken, publicOrigin)
    service.hostDecision(hostRow, claim.requestId, true)
    const poll = service.poll(claim.requestId, claim.pairingToken, publicOrigin)
    assert.ok(poll.cookie)
    const session = node.app.services.sessions.resolve(poll.cookie.token, publicOrigin)
    assert.ok(session, 'the cookie is bound to the canonical public origin')
    assert.equal(session.session.bound_origin, publicOrigin)
    assert.equal(node.app.services.sessions.resolve(poll.cookie.token, 'https://other.example'), null)
  } finally {
    await node.stop()
  }
})

test('X-Forwarded-* is trusted only when TRUST_PROXY is enabled', async () => {
  const plain = await startNode()
  try {
    const forwarded = await rawRequest(plain.app.server.address().port, {
      method: 'POST',
      path: '/v1/hosts',
      headers: {
        'content-type': 'application/json',
        host: 'public.example',
        origin: 'https://public.example',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'public.example',
      },
      body: JSON.stringify(hostRegistration()),
    })
    assert.equal(forwarded.status, 403, 'forwarded headers must be ignored without TRUST_PROXY')
  } finally {
    await plain.stop()
  }

  const proxied = await startNode({ TRUST_PROXY: '1' })
  try {
    const forwarded = await rawRequest(proxied.app.server.address().port, {
      method: 'POST',
      path: '/v1/hosts',
      headers: {
        'content-type': 'application/json',
        host: '127.0.0.1',
        origin: 'https://public.example',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'public.example',
      },
      body: JSON.stringify(hostRegistration()),
    })
    assert.equal(forwarded.status, 201, 'the canonical origin must come from X-Forwarded-* when trusted')
  } finally {
    await proxied.stop()
  }
})

test('WebSocket upgrades from a foreign origin are refused', async () => {
  const node = await startNode()
  const host = await registerHost(node, hostRegistration())
  try {
    await assert.rejects(
      connectControl(node, hostHello(node, host), { origin: 'https://evil.example' }),
      (error: any) => error.statusCode === 403,
    )
  } finally {
    await node.stop()
  }
})

test('upgrades to the wrong path are refused', async () => {
  const node = await startNode()
  try {
    const port = node.app.server.address().port
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/controlx`, { origin: node.baseUrl })
      ws.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0))
      ws.on('open', () => reject(new Error('upgrade unexpectedly succeeded')))
      ws.on('error', () => {
        // The unexpected-response handler resolves first.
      })
    })
    assert.equal(status, 404)
  } finally {
    await node.stop()
  }
})

test('damaged cookies and hostile headers never produce 500s', async () => {
  const node = await startNode()
  try {
    const malformed = await api(node.baseUrl, 'GET', '/v1/hosts', {
      cookie: 'dsh_session=%E0%A4%A',
    })
    assert.equal(malformed.status, 401)
    assert.equal(malformed.json.error.code, 'AUTH_REQUIRED')

    const duplicate = await api(node.baseUrl, 'GET', '/v1/hosts', {
      cookie: 'dsh_session=abc; dsh_session=def',
    })
    assert.equal(duplicate.status, 401)

    const huge = await api(node.baseUrl, 'GET', '/v1/hosts', {
      cookie: `dsh_session=${'A'.repeat(9_000)}`,
    })
    assert.equal(huge.status, 401)

    const noBearer = await api(node.baseUrl, 'DELETE', '/v1/hosts/x/devices/y', { headers: { authorization: 'Basic abc' } })
    assert.equal(noBearer.status, 401)
    assert.equal(noBearer.json.error.code, 'AUTH_REQUIRED')

    const badToken = await api(node.baseUrl, 'POST', '/v1/pairings', {
      headers: { authorization: 'Bearer not-a-valid-token' },
    })
    assert.equal(badToken.status, 401)

    const wrongMethod = await api(node.baseUrl, 'DELETE', '/.well-known/dsh-remote')
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.json.error.code, 'METHOD_NOT_ALLOWED')

    const notFound = await api(node.baseUrl, 'GET', '/definitely-not-here')
    assert.equal(notFound.status, 404)
    assert.equal(notFound.json.error.code, 'NOT_FOUND')

    const healthz = await api(node.baseUrl, 'GET', '/healthz')
    assert.equal(healthz.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(healthz.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(healthz.headers.get('x-frame-options'), 'DENY')

    const landing = await api(node.baseUrl, 'GET', '/')
    assert.equal(landing.status, 200)
    assert.match(String(landing.headers.get('content-security-policy')), /default-src 'none'/u)
    assert.match(String(landing.headers.get('content-security-policy')), /script-src 'unsafe-inline'/u)
  } finally {
    await node.stop()
  }
})
