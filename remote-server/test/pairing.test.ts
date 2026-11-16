import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { ApiError } from '../dist/remote-server/src/errors.js'
import {
  api,
  completePairing,
  hostRegistration,
  parseSetCookie,
  randomDeviceId,
  randomIdentityKey,
  randomToken,
  registerHost,
  startNode,
  TestHost,
  verificationCodeFor,
} from './helpers.ts'

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

test('pairing needs the phone decision and the desktop decision before a cookie is issued', async () => {
  const node = await startNode()
  const host = await registerHost(node, hostRegistration())
  const hostClient = await TestHost.connect(node, host)
  try {
    const ticketResponse = await api(node.baseUrl, 'POST', '/v1/pairings', { token: host.credential })
    assert.equal(ticketResponse.status, 201)
    const ticket = ticketResponse.json.ticket
    assert.match(ticket, /^[A-Za-z0-9_-]{43}$/u)
    assert.ok(ticketResponse.json.expiresAt > Date.now())
    assert.ok(ticketResponse.json.expiresAt - Date.now() <= 5 * 60_000 + 1_000, 'tickets live at most 5 minutes')
    assert.equal(ticketResponse.json.host.hostId, host.host.hostId)

    const client = {
      deviceId: randomDeviceId(),
      name: '测试手机',
      platform: 'ios',
      identityKey: randomIdentityKey(),
    }
    const claim = await api(node.baseUrl, 'POST', '/v1/pairings/claim', { body: { ticket, client } })
    assert.equal(claim.status, 201)
    assert.match(claim.json.requestId, /^[0-9a-f-]{36}$/u)
    assert.match(claim.json.pairingToken, /^[A-Za-z0-9_-]{43}$/u)
    assert.equal(claim.json.host.name, host.registration.name)
    assert.equal(claim.json.host.hostId, host.host.hostId)
    assert.equal(claim.json.host.fingerprint, host.host.fingerprint)
    const expectedCode = verificationCodeFor(ticket, host.registration.identityKey, client.identityKey)
    assert.equal(claim.json.verificationCode, expectedCode)

    const pairRequest = await hostClient.nextOfType('pair.request')
    assert.equal(pairRequest.frame.requestId, claim.json.requestId)
    assert.equal(pairRequest.frame.verificationCode, expectedCode)
    assert.match(pairRequest.frame.verificationCode, /^\d{8}$/u)
    assert.equal(pairRequest.frame.clientDeviceId, client.deviceId)
    assert.equal(pairRequest.frame.clientIdentityKey, client.identityKey)

    const phoneDecision = await api(node.baseUrl, 'POST', `/v1/pairings/${claim.json.requestId}/confirm`, {
      headers: { 'x-pairing-token': claim.json.pairingToken },
    })
    assert.equal(phoneDecision.status, 200)
    assert.equal(phoneDecision.json.state, 'client_approved')
    assert.equal(phoneDecision.json.complete, false)
    assert.equal(phoneDecision.setCookies.length, 0, 'one decision must not issue a device cookie')

    const beforeDesktop = await api(node.baseUrl, 'GET', `/v1/pairings/${claim.json.requestId}`, {
      headers: { 'x-pairing-token': claim.json.pairingToken },
    })
    assert.equal(beforeDesktop.json.state, 'client_approved')
    assert.equal(beforeDesktop.setCookies.length, 0)

    hostClient.send({ t: 'pair.approve', requestId: claim.json.requestId })
    const completeFrame = await hostClient.nextOfType('pair.complete')
    assert.equal(completeFrame.frame.requestId, claim.json.requestId)
    assert.equal(completeFrame.frame.clientDeviceId, client.deviceId)
    assert.equal(completeFrame.frame.clientIdentityKey, client.identityKey)

    const done = await api(node.baseUrl, 'GET', `/v1/pairings/${claim.json.requestId}`, {
      headers: { 'x-pairing-token': claim.json.pairingToken },
    })
    assert.equal(done.status, 200)
    assert.equal(done.json.complete, true)
    assert.equal(done.json.state, 'complete')
    assert.equal(done.setCookies.length, 1)
    const cookie = parseSetCookie(done.setCookies[0])
    assert.equal(cookie.name, 'dsh_session')
    assert.match(cookie.value, /^[A-Za-z0-9_-]{43}$/u)
    assert.equal(cookie.path, '/')
    assert.equal(cookie.secure, true, 'device cookies must be Secure')
    assert.equal(cookie.httpOnly, true, 'device cookies must be HttpOnly')
    assert.equal(cookie.sameSite, 'Strict')
    assert.ok(cookie.maxAge !== null && cookie.maxAge >= 2_590_000 && cookie.maxAge <= 2_592_000)

    const replay = await api(node.baseUrl, 'GET', `/v1/pairings/${claim.json.requestId}`, {
      headers: { 'x-pairing-token': claim.json.pairingToken },
    })
    assert.equal(replay.setCookies.length, 0, 'the device cookie is issued exactly once')

    const list = await api(node.baseUrl, 'GET', '/v1/hosts', { cookie: done.setCookies[0].split(';')[0] })
    assert.equal(list.status, 200)
    assert.equal(list.json.hosts.length, 1)
    assert.equal(list.json.hosts[0].hostId, host.host.hostId)
    assert.equal(list.json.hosts[0].status, 'active')

    const sessionRow: any = node.app.db
      .prepare('SELECT * FROM device_sessions WHERE device_id = ?')
      .get(client.deviceId)
    assert.equal(sessionRow.credential_hash, sha256Hex(cookie.value), 'only the session token hash is stored')
    assert.notEqual(sessionRow.credential_hash, cookie.value)
    assert.equal(sessionRow.bound_origin, node.baseUrl)

    const relationship: any = node.app.db
      .prepare('SELECT * FROM relationships WHERE client_device_id = ?')
      .get(client.deviceId)
    assert.equal(relationship.host_id, host.host.hostId)
    assert.equal(relationship.client_identity_key, client.identityKey)
    assert.equal(relationship.revoked_at, null)
  } finally {
    hostClient.close()
    await node.stop()
  }
})

test('desktop approval first still waits for the phone decision', async () => {
  const node = await startNode()
  const host = await registerHost(node, hostRegistration())
  const hostClient = await TestHost.connect(node, host)
  try {
    const ticketResponse = await api(node.baseUrl, 'POST', '/v1/pairings', { token: host.credential })
    const client = { deviceId: randomDeviceId(), name: '手机', platform: 'android', identityKey: randomIdentityKey() }
    const claim = await api(node.baseUrl, 'POST', '/v1/pairings/claim', {
      body: { ticket: ticketResponse.json.ticket, client },
    })
    await hostClient.nextOfType('pair.request')

    hostClient.send({ t: 'pair.approve', requestId: claim.json.requestId })
    const waiting = await api(node.baseUrl, 'GET', `/v1/pairings/${claim.json.requestId}`, {
      headers: { 'x-pairing-token': claim.json.pairingToken },
    })
    assert.equal(waiting.json.state, 'host_approved')
    assert.equal(waiting.json.complete, false)
    assert.equal(waiting.setCookies.length, 0)

    const confirmed = await api(node.baseUrl, 'POST', `/v1/pairings/${claim.json.requestId}/confirm`, {
      headers: { 'x-pairing-token': claim.json.pairingToken },
    })
    assert.equal(confirmed.status, 200)
    assert.equal(confirmed.json.complete, true)
    assert.equal(confirmed.setCookies.length, 1)
    assert.equal(parseSetCookie(confirmed.setCookies[0]).name, 'dsh_session')
  } finally {
    hostClient.close()
    await node.stop()
  }
})

test('pairing tickets are single use and pairing tokens are enforced', async () => {
  const node = await startNode()
  const host = await registerHost(node, hostRegistration())
  const hostClient = await TestHost.connect(node, host)
  try {
    const ticketResponse = await api(node.baseUrl, 'POST', '/v1/pairings', { token: host.credential })
    const client = { deviceId: randomDeviceId(), name: '手机', platform: 'ios', identityKey: randomIdentityKey() }
    const claim = await api(node.baseUrl, 'POST', '/v1/pairings/claim', {
      body: { ticket: ticketResponse.json.ticket, client },
    })
    assert.equal(claim.status, 201)
    await hostClient.nextOfType('pair.request')

    const replayClaim = await api(node.baseUrl, 'POST', '/v1/pairings/claim', {
      body: { ticket: ticketResponse.json.ticket, client },
    })
    assert.equal(replayClaim.status, 409)
    assert.equal(replayClaim.json.error.code, 'TICKET_USED')

    const wrongToken = await api(node.baseUrl, 'GET', `/v1/pairings/${claim.json.requestId}`, {
      headers: { 'x-pairing-token': randomToken() },
    })
    assert.equal(wrongToken.status, 401)
    assert.equal(wrongToken.json.error.code, 'PAIRING_TOKEN_INVALID')

    const missingToken = await api(node.baseUrl, 'POST', `/v1/pairings/${claim.json.requestId}/confirm`)
    assert.equal(missingToken.status, 401)
    assert.equal(missingToken.json.error.code, 'PAIRING_TOKEN_REQUIRED')

    const unknownRequest = await api(node.baseUrl, 'GET', '/v1/pairings/00000000-0000-4000-8000-000000000000', {
      headers: { 'x-pairing-token': claim.json.pairingToken },
    })
    assert.equal(unknownRequest.status, 404)
    assert.equal(unknownRequest.json.error.code, 'PAIRING_NOT_FOUND')
  } finally {
    hostClient.close()
    await node.stop()
  }
})

test('expired tickets and expired pairing requests are rejected', async () => {
  const node = await startNode()
  const host = await registerHost(node, hostRegistration())
  try {
    const PairingService = (await import('../dist/remote-server/src/pairing.js')).PairingService
    let now = Date.now()
    const service = new PairingService(node.app.services.repos, node.app.config, node.app.services.sessions, () => now)
    service.attach({
      isHostOnline: () => true,
      sendToHost: () => true,
    })
    const hostRow = node.app.services.repos.findHostByDeviceId(host.registration.deviceId)
    const client = { deviceId: randomDeviceId(), name: '手机', platform: 'ios', identityKey: randomIdentityKey() }

    const expiredTicket = service.createTicket(hostRow, {})
    now += 6 * 60_000
    assert.throws(
      () => service.claim({ ticket: expiredTicket.ticket, client }),
      (error: unknown) => error instanceof ApiError && error.status === 410 && error.code === 'TICKET_EXPIRED',
    )

    const freshTicket = service.createTicket(hostRow, {})
    const claim = service.claim({ ticket: freshTicket.ticket, client })
    now += 6 * 60_000
    assert.throws(
      () => service.clientConfirm(claim.requestId, claim.pairingToken, node.baseUrl),
      (error: unknown) => error instanceof ApiError && error.status === 410 && error.code === 'PAIRING_EXPIRED',
    )
  } finally {
    await node.stop()
  }
})

test('ticket expiry is clamped to five minutes even when the Host asks for longer', async () => {
  const node = await startNode()
  const host = await registerHost(node, hostRegistration())
  try {
    const before = Date.now()
    const ticket = await api(node.baseUrl, 'POST', '/v1/pairings', {
      token: host.credential,
      body: { expiresAt: before + 60 * 60_000 },
    })
    assert.equal(ticket.status, 201)
    assert.ok(ticket.json.expiresAt <= before + 5 * 60_000 + 1_000)
    assert.ok(ticket.json.expiresAt >= before + 4 * 60_000)

    const invalid = await api(node.baseUrl, 'POST', '/v1/pairings', {
      token: host.credential,
      body: { ticket: 'short' },
    })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.json.error.code, 'INVALID_REQUEST')

    const past = await api(node.baseUrl, 'POST', '/v1/pairings', {
      token: host.credential,
      body: { expiresAt: before - 1_000 },
    })
    assert.equal(past.status, 400)
    assert.equal(past.json.error.code, 'INVALID_TICKET')

    const unauthenticated = await api(node.baseUrl, 'POST', '/v1/pairings')
    assert.equal(unauthenticated.status, 401)
  } finally {
    await node.stop()
  }
})

test('a ticket cannot be claimed while the Host is offline', async () => {
  const node = await startNode()
  const host = await registerHost(node, hostRegistration())
  try {
    const ticket = await api(node.baseUrl, 'POST', '/v1/pairings', { token: host.credential })
    assert.equal(ticket.status, 201)
    const client = { deviceId: randomDeviceId(), name: '手机', platform: 'ios', identityKey: randomIdentityKey() }
    const claim = await api(node.baseUrl, 'POST', '/v1/pairings/claim', {
      body: { ticket: ticket.json.ticket, client },
    })
    assert.equal(claim.status, 409)
    assert.equal(claim.json.error.code, 'HOST_OFFLINE')
  } finally {
    await node.stop()
  }
})

test('rejections issue no cookie and are visible to both sides', async () => {
  const node = await startNode()
  const host = await registerHost(node, hostRegistration())
  const hostClient = await TestHost.connect(node, host)
  try {
    const ticketA = await api(node.baseUrl, 'POST', '/v1/pairings', { token: host.credential })
    const clientA = { deviceId: randomDeviceId(), name: '手机A', platform: 'ios', identityKey: randomIdentityKey() }
    const claimA = await api(node.baseUrl, 'POST', '/v1/pairings/claim', {
      body: { ticket: ticketA.json.ticket, client: clientA },
    })
    await hostClient.nextOfType('pair.request')
    hostClient.send({ t: 'pair.reject', requestId: claimA.json.requestId })
    await hostClient.nextOfType('pair.reject')
    const rejected = await api(node.baseUrl, 'GET', `/v1/pairings/${claimA.json.requestId}`, {
      headers: { 'x-pairing-token': claimA.json.pairingToken },
    })
    assert.equal(rejected.json.state, 'rejected')
    assert.equal(rejected.setCookies.length, 0)
    const lateConfirm = await api(node.baseUrl, 'POST', `/v1/pairings/${claimA.json.requestId}/confirm`, {
      headers: { 'x-pairing-token': claimA.json.pairingToken },
    })
    assert.equal(lateConfirm.status, 410)
    assert.equal(lateConfirm.json.error.code, 'PAIRING_REJECTED')

    const ticketB = await api(node.baseUrl, 'POST', '/v1/pairings', { token: host.credential })
    const clientB = { deviceId: randomDeviceId(), name: '手机B', platform: 'ios', identityKey: randomIdentityKey() }
    const claimB = await api(node.baseUrl, 'POST', '/v1/pairings/claim', {
      body: { ticket: ticketB.json.ticket, client: clientB },
    })
    await hostClient.nextOfType('pair.request')
    const phoneReject = await api(node.baseUrl, 'POST', `/v1/pairings/${claimB.json.requestId}/reject`, {
      headers: { 'x-pairing-token': claimB.json.pairingToken },
    })
    assert.equal(phoneReject.status, 200)
    assert.equal(phoneReject.json.state, 'rejected')
    hostClient.send({ t: 'pair.approve', requestId: claimB.json.requestId })
    const stillRejected = await api(node.baseUrl, 'GET', `/v1/pairings/${claimB.json.requestId}`, {
      headers: { 'x-pairing-token': claimB.json.pairingToken },
    })
    assert.equal(stillRejected.json.state, 'rejected')
    assert.equal(stillRejected.setCookies.length, 0)
  } finally {
    hostClient.close()
    await node.stop()
  }
})

test('reusing a paired device id with another identity key fails closed', async () => {
  const node = await startNode()
  const paired = await completePairing(node)
  try {
    const ticket = await api(node.baseUrl, 'POST', '/v1/pairings', { token: paired.host.credential })
    const impostor = {
      deviceId: paired.client.deviceId,
      name: '另一台手机',
      platform: 'android',
      identityKey: randomIdentityKey(),
    }
    const claim = await api(node.baseUrl, 'POST', '/v1/pairings/claim', {
      body: { ticket: ticket.json.ticket, client: impostor },
    })
    assert.equal(claim.status, 409)
    assert.equal(claim.json.error.code, 'DEVICE_IDENTITY_MISMATCH')
    assert.equal(claim.setCookies.length, 0)
  } finally {
    paired.hostClient.close()
    await node.stop()
  }
})

test('the pairing page never renders the eight-digit comparison code', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8')
  // The transport field is v1 compatibility only; the phone page must not show it.
  assert.doesNotMatch(html, /verificationCode/u)
  assert.doesNotMatch(html, /id="code"/u)
  assert.doesNotMatch(html, /8 位验证码/u)
  assert.doesNotMatch(html, /\b\d{8}\b/u, 'no eight-digit numeric run may appear in the page')

  // The trust anchor is computed locally from the QR key parameter.
  assert.match(html, /确认是本机/u)
  assert.match(html, /目标主机指纹/u)
  assert.match(html, /hostIdentityKey/u)
  assert.match(html, /crypto\.subtle\.digest\('SHA-256'/u)
  assert.match(html, /fromB64url/u)
})
