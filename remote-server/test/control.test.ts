import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import {
  clientHello,
  completePairing,
  connectClient,
  connectControl,
  connectHost,
  delay,
  hostHello,
  hostRegistration,
  randomDeviceId,
  randomIdentityKey,
  registerHost,
  startNode,
} from './helpers.ts'

const MAX_CONTROL_FRAME_BYTES = 64 * 1024
const MAX_RELAY_FRAME_BYTES = 1024 * 1024

function relayCiphertext(label: string): string {
  return Buffer.from(label, 'utf8').toString('base64url')
}

test('hello.ack advertises the negotiated protocol, limits and capabilities', async () => {
  const node = await startNode()
  const host = await registerHost(node, hostRegistration())
  const hostClient = await connectHost(node, host)
  try {
    const ack = hostClient.history.find(frame => frame.type === 'hello.ack')
    assert.ok(ack, 'hello.ack must be the first answered frame')
    assert.equal(ack.payload.protocol, 1)
    assert.equal(ack.payload.serverVersion, node.app.config.nodeVersion)
    assert.match(ack.payload.connectionSessionId, /^[0-9a-f-]{36}$/u)
    assert.equal(ack.payload.heartbeatIntervalMs, 25_000)
    assert.equal(ack.payload.maxControlFrameBytes, MAX_CONTROL_FRAME_BYTES)
    assert.equal(ack.payload.maxRelayFrameBytes, MAX_RELAY_FRAME_BYTES)
    assert.deepEqual(ack.payload.capabilities, node.app.config.capabilities)
    assert.equal(ack.payload.webrtcEnabled, false)
  } finally {
    hostClient.close()
    await node.stop()
  }
})

test('wrong credentials and unsupported protocol versions are rejected at hello time', async () => {
  const node = await startNode()
  const host = await registerHost(node, hostRegistration())
  try {
    const badCredential = await connectControl(node, hostHello(node, host, { accessToken: 'A'.repeat(43) }), {
      skipHello: true,
    })
    badCredential.ws.send(JSON.stringify(hostHello(node, host, { accessToken: 'A'.repeat(43) })))
    const authError = await badCredential.next('error')
    assert.equal(authError.payload.code, 'AUTH_INVALID')
    const authClose = await badCredential.waitClose()
    assert.equal(authClose.code, 4001)
    assert.equal(authClose.reason, 'authentication failed')

    const wrongVersion = await connectControl(node, hostHello(node, host), { skipHello: true })
    wrongVersion.ws.send(JSON.stringify(hostHello(node, host, { protocols: [2] })))
    const versionError = await wrongVersion.next('error')
    assert.equal(versionError.payload.code, 'UNSUPPORTED_VERSION')
    const versionClose = await wrongVersion.waitClose()
    assert.equal(versionClose.code, 4001)
    assert.equal(versionClose.reason, 'unsupported protocol version')

    const wrongDevice = await connectControl(node, hostHello(node, host), { skipHello: true })
    wrongDevice.ws.send(JSON.stringify(hostHello(node, host, { deviceId: randomDeviceId() })))
    const deviceError = await wrongDevice.next('error')
    assert.equal(deviceError.payload.code, 'AUTH_INVALID')
    await wrongDevice.waitClose()
  } finally {
    await node.stop()
  }
})

test('connections without a valid hello are closed', async () => {
  const node = await startNode()
  try {
    const silent = await connectControl(node, {}, { skipHello: true })
    const timeoutClose = await silent.waitClose(6_000)
    assert.equal(timeoutClose.code, 4001)
    assert.equal(timeoutClose.reason, 'hello timeout')

    const chatty = await connectControl(node, {}, { skipHello: true })
    chatty.send('ping', { nonce: 'x' })
    const close = await chatty.waitClose()
    assert.equal(close.code, 4001)
    assert.equal(close.reason, 'hello required')
  } finally {
    await node.stop()
  }
})

test('a newer Host connection replaces the old one with close code 4003', async () => {
  const node = await startNode()
  const host = await registerHost(node, hostRegistration())
  try {
    const first = await connectHost(node, host)
    const second = await connectHost(node, host)
    const closeInfo = await first.waitClose()
    assert.equal(closeInfo.code, 4003)
    assert.equal(closeInfo.reason, 'replaced by a newer connection')
    second.close()
  } finally {
    await node.stop()
  }
})

test('pings are answered with matching pongs on an authenticated connection', async () => {
  const node = await startNode()
  const host = await registerHost(node, hostRegistration())
  const hostClient = await connectHost(node, host)
  try {
    hostClient.send('ping', { nonce: 'abc-123' })
    const pong = await hostClient.next('pong')
    assert.equal(pong.payload.nonce, 'abc-123')
  } finally {
    hostClient.close()
    await node.stop()
  }
})

test('connect requests require an active relationship and a live Host', async () => {
  const node = await startNode()
  const paired = await completePairing(node)
  let client: Awaited<ReturnType<typeof connectClient>> | null = null
  try {
    client = await connectClient(node, paired.client.deviceId, paired.sessionToken)

    client.send('connect.request', { hostDeviceId: randomDeviceId(), preferredTransports: ['relay'] })
    const unknownHost = await client.next('error')
    assert.equal(unknownHost.payload.code, 'DEVICE_NOT_FOUND')

    client.send('connect.request', { hostDeviceId: paired.hostDeviceId, preferredTransports: ['relay'] })
    const accepted = await client.next('connect.accepted')
    assert.ok(accepted.payload.connectionId)
    const incoming = await paired.hostClient.next('connect.incoming')
    assert.equal(incoming.payload.connectionId, accepted.payload.connectionId)
    assert.equal(incoming.payload.clientDeviceId, paired.client.deviceId)
    assert.equal(incoming.payload.clientIdentityKey, paired.client.identityKey)
    assert.equal(incoming.payload.authorization, 'account')

    paired.hostClient.close()
    await paired.hostClient.waitClose()
    await delay(50)
    client.send('connect.request', { hostDeviceId: paired.hostDeviceId, preferredTransports: ['relay'] })
    const offline = await client.next('error')
    assert.equal(offline.payload.code, 'HOST_OFFLINE')
  } finally {
    client?.close()
    await node.stop()
  }
})

test('Noise frames and relay ciphertext are forwarded verbatim in both directions', async () => {
  const node = await startNode()
  const paired = await completePairing(node)
  let client: Awaited<ReturnType<typeof connectClient>> | null = null
  try {
    client = await connectClient(node, paired.client.deviceId, paired.sessionToken)
    client.send('connect.request', { hostDeviceId: paired.hostDeviceId, preferredTransports: ['relay'] })
    const accepted = await client.next('connect.accepted')
    const incoming = await paired.hostClient.next('connect.incoming')
    const connectionId: string = accepted.payload.connectionId
    assert.equal(incoming.payload.connectionId, connectionId)

    const handshake1 = relayCiphertext('noise-handshake-1')
    client.send('secure.handshake', {
      connectionId,
      targetDeviceId: paired.hostDeviceId,
      step: 1,
      data: handshake1,
    })
    const forwardedHandshake = await paired.hostClient.next('secure.handshake')
    assert.equal(forwardedHandshake.payload.data, handshake1)
    assert.equal(forwardedHandshake.payload.connectionId, connectionId)

    const clientCiphertext = relayCiphertext('client-to-host-secret')
    client.send('relay', {
      connectionId,
      targetDeviceId: paired.hostDeviceId,
      counter: 0,
      ciphertext: clientCiphertext,
    })
    const forwardedClient = await paired.hostClient.next('relay')
    assert.equal(forwardedClient.payload.ciphertext, clientCiphertext)
    assert.equal(forwardedClient.payload.counter, 0)

    const hostCiphertext = relayCiphertext('host-to-client-secret')
    paired.hostClient.send('relay', {
      connectionId,
      targetDeviceId: paired.client.deviceId,
      counter: 0,
      ciphertext: hostCiphertext,
    })
    const forwardedHost = await client.next('relay')
    assert.equal(forwardedHost.payload.ciphertext, hostCiphertext)
    assert.equal(forwardedHost.payload.targetDeviceId, paired.client.deviceId)

    client.send('relay', {
      connectionId,
      targetDeviceId: paired.hostDeviceId,
      counter: 0,
      ciphertext: relayCiphertext('replayed'),
    })
    const replayError = await client.next('error')
    assert.equal(replayError.payload.code, 'INVALID_MESSAGE')
    assert.match(replayError.payload.message, /relay counter must strictly increase/u)

    client.send('relay', {
      connectionId,
      targetDeviceId: paired.hostDeviceId,
      counter: 1,
      ciphertext: relayCiphertext('after-replay'),
    })
    const forwardedAfterReplay = await paired.hostClient.next('relay')
    assert.equal(forwardedAfterReplay.payload.counter, 1)
  } finally {
    client?.close()
    paired.hostClient.close()
    await node.stop()
  }
})

test('frames for unknown connections, wrong peers or wrong roles are rejected', async () => {
  const node = await startNode()
  const paired = await completePairing(node)
  let client: Awaited<ReturnType<typeof connectClient>> | null = null
  try {
    client = await connectClient(node, paired.client.deviceId, paired.sessionToken)
    client.send('connect.request', { hostDeviceId: paired.hostDeviceId, preferredTransports: ['relay'] })
    const accepted = await client.next('connect.accepted')
    const connectionId: string = accepted.payload.connectionId
    await paired.hostClient.next('connect.incoming')

    client.send('relay', {
      connectionId: randomUUID(),
      targetDeviceId: paired.hostDeviceId,
      counter: 0,
      ciphertext: relayCiphertext('no-connection'),
    })
    const missing = await client.next('error')
    assert.equal(missing.payload.code, 'CONNECTION_NOT_FOUND')

    client.send('relay', {
      connectionId,
      targetDeviceId: randomDeviceId(),
      counter: 0,
      ciphertext: relayCiphertext('wrong-target'),
    })
    const wrongTarget = await client.next('error')
    assert.equal(wrongTarget.payload.code, 'INVALID_MESSAGE')

    client.send('pair.approve', { requestId: randomUUID() })
    const wrongRole = await client.next('error')
    assert.equal(wrongRole.payload.code, 'METHOD_NOT_ALLOWED')

    paired.hostClient.send('connect.request', { hostDeviceId: paired.hostDeviceId, preferredTransports: ['relay'] })
    const hostRole = await paired.hostClient.next('error')
    assert.equal(hostRole.payload.code, 'METHOD_NOT_ALLOWED')
  } finally {
    client?.close()
    paired.hostClient.close()
    await node.stop()
  }
})

test('malformed and oversized frames close with policy codes instead of crashing', async () => {
  const node = await startNode()
  const host = await registerHost(node, hostRegistration())
  try {
    const invalidJson = await connectHost(node, host)
    invalidJson.ws.send('{not json')
    const jsonClose = await invalidJson.waitClose()
    assert.equal(jsonClose.code, 1008)
    assert.equal(jsonClose.reason, 'invalid control frame')

    const invalidShape = await connectHost(node, host)
    invalidShape.ws.send(JSON.stringify({ v: 1, type: 'relay' }))
    const shapeClose = await invalidShape.waitClose()
    assert.equal(shapeClose.code, 1008)

    const oversizedControl = await connectHost(node, host)
    oversizedControl.ws.send(
      JSON.stringify({
        v: 1,
        id: randomUUID(),
        type: 'signal.offer',
        timestamp: Date.now(),
        payload: {
          connectionId: randomUUID(),
          targetDeviceId: randomDeviceId(),
          sdp: 'x'.repeat(MAX_CONTROL_FRAME_BYTES + 1024),
        },
      }),
    )
    const controlClose = await oversizedControl.waitClose()
    assert.equal(controlClose.code, 1008)
    assert.equal(controlClose.reason, 'invalid control frame')

    const oversizedPayload = await connectHost(node, host)
    oversizedPayload.ws.send('x'.repeat(2 * MAX_RELAY_FRAME_BYTES))
    const payloadClose = await oversizedPayload.waitClose()
    assert.equal(payloadClose.code, 1009, 'the WebSocket layer must enforce the relay frame limit')

    const stillAlive = await connectHost(node, host)
    stillAlive.send('ping', { nonce: 'ok' })
    assert.equal((await stillAlive.next('pong')).payload.nonce, 'ok')
    stillAlive.close()
  } finally {
    await node.stop()
  }
})

test('frame floods trip the control frame rate limiter', async () => {
  const node = await startNode()
  const host = await registerHost(node, hostRegistration())
  const hostClient = await connectHost(node, host)
  try {
    const frame = JSON.stringify({
      v: 1,
      id: randomUUID(),
      type: 'ping',
      timestamp: Date.now(),
      payload: { nonce: 'flood' },
    })
    for (let index = 0; index < 4_000; index += 1) hostClient.ws.send(frame)
    const closeInfo = await hostClient.waitClose(10_000)
    assert.equal(closeInfo.code, 1008)
    assert.equal(closeInfo.reason, 'rate limit exceeded')
  } finally {
    await node.stop()
  }
})

test('a client cannot authenticate with a forged device session', async () => {
  const node = await startNode()
  try {
    const forged = await connectControl(node, clientHello(node, randomDeviceId(), randomIdentityKey()), {
      skipHello: true,
    })
    forged.ws.send(JSON.stringify(clientHello(node, randomDeviceId(), randomIdentityKey())))
    const errorFrame = await forged.next('error')
    assert.equal(errorFrame.payload.code, 'AUTH_INVALID')
    await forged.waitClose()
  } finally {
    await node.stop()
  }
})
