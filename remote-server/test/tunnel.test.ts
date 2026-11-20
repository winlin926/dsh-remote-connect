import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { test } from 'node:test'
import WebSocket from 'ws'
import {
  splitTunnelPayload,
  type TunnelFrame,
  type TunnelHeaders,
  type TunnelHttpRequestFrame,
} from '../dist/src/remote/tunnel-protocol.js'
import {
  api,
  completePairing,
  delay,
  randomIdentityKey,
  registerHost,
  hostIdentityFromKey,
  hostRegistration,
  startNode,
  TestHost,
  type HostFrame,
  type PairedDevice,
  type RegisteredHost,
  type TestNode,
} from './helpers.ts'

function requestFrame(entry: HostFrame): TunnelHttpRequestFrame {
  assert.equal(entry.frame.t, 'http.request')
  return entry.frame as TunnelHttpRequestFrame
}

function sendResponse(
  host: TestHost,
  id: string,
  options: { status?: number; headers?: TunnelHeaders; body?: string | Buffer },
): void {
  host.send({ t: 'http.response', id, status: options.status ?? 200, headers: options.headers ?? {} })
  const body = options.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body, 'utf8')
  for (const slice of splitTunnelPayload(body)) host.send({ t: 'http.chunk', id }, slice)
  host.send({ t: 'http.end', id })
}

function sendJson(host: TestHost, id: string, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  sendResponse(host, id, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(body)) },
    body,
  })
}

async function collectBody(host: TestHost, id: string, timeoutMs = 5_000): Promise<{ body: Buffer; frames: number }> {
  const chunks: Buffer[] = []
  for (;;) {
    const entry = await host.next(
      frame => (frame.t === 'http.body' || frame.t === 'http.body.end') && frame.id === id,
      timeoutMs,
    )
    if (entry.frame.t === 'http.body.end') break
    chunks.push(entry.payload)
  }
  return { body: Buffer.concat(chunks), frames: chunks.length }
}

interface HttpClientResult {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function httpGet(port: number, path: string, headers: Record<string, string>): Promise<HttpClientResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
      res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.from(chunk)))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function nodePort(node: TestNode): number {
  return Number(new URL(node.baseUrl).port)
}

/** Pair a phone, then replace the control Host with a tunnel-only Host. */
async function pairAndConnect(node: TestNode): Promise<{ paired: PairedDevice; host: TestHost }> {
  const paired = await completePairing(node)
  paired.hostClient.close()
  await paired.hostClient.waitOffline()
  const host = await TestHost.connect(node, paired.host)
  return { paired, host }
}

test('host registration accepts a 43-character Base64URL device id', async () => {
  const node = await startNode()
  try {
    const identityKey = randomIdentityKey()
    const expected = hostIdentityFromKey(identityKey)
    const deviceId = randomBytes(32).toString('base64url')
    assert.equal(deviceId.length, 43)

    const result = await api(node.baseUrl, 'POST', '/v1/hosts', {
      body: hostRegistration({ deviceId, identityKey }),
    })
    assert.equal(result.status, 201)
    assert.equal(typeof result.json.credential, 'string')
    assert.ok(result.json.credential.length >= 16)
    assert.equal(result.json.host.hostId, expected.hostId)
    assert.equal(result.json.host.deviceId, deviceId)
    assert.equal(result.json.host.fingerprint, expected.fingerprint)

    // Pairing clients still require ULID/UUID device ids.
    const rejected = await api(node.baseUrl, 'POST', '/v1/pairings/claim', {
      body: { ticket: 'x'.repeat(32), client: { deviceId, name: '手机', platform: 'ios', identityKey: randomIdentityKey() } },
    })
    assert.equal(rejected.status, 400)
  } finally {
    await node.stop()
  }
})

test('a paired device reaches the Host over the tunnel and receives a streamed large body', async () => {
  const node = await startNode()
  try {
    const { paired, host } = await pairAndConnect(node)
    const body = `tunnel-body:${'x'.repeat(120_000)}`
    const pending = api(node.baseUrl, 'GET', '/api/hello', { cookie: paired.cookie })

    const entry = await host.nextOfType('http.request')
    const request = requestFrame(entry)
    assert.equal(request.method, 'GET')
    assert.equal(request.path, '/api/hello')
    assert.match(String(request.headers.cookie), /dsh_session=/u)

    const frames = splitTunnelPayload(Buffer.from(body, 'utf8'))
    assert.ok(frames.length >= 3, `expected several chunk frames, got ${frames.length}`)
    host.send({
      t: 'http.response',
      id: request.id,
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(Buffer.byteLength(body)) },
    })
    for (const slice of frames) host.send({ t: 'http.chunk', id: request.id }, slice)
    host.send({ t: 'http.end', id: request.id })

    const response = await pending
    assert.equal(response.status, 200)
    assert.equal(response.text, body)
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
  } finally {
    await node.stop()
  }
})

test('Host status codes and headers pass through the tunnel', async () => {
  const node = await startNode()
  try {
    const { paired, host } = await pairAndConnect(node)
    const pending = api(node.baseUrl, 'GET', '/api/missing', { cookie: paired.cookie })
    const entry = await host.nextOfType('http.request')
    const request = requestFrame(entry)
    assert.equal(request.path, '/api/missing')
    sendJson(host, request.id, 404, { error: { code: 'HOST_NOT_FOUND', message: 'The page is not here.' } })
    const response = await pending
    assert.equal(response.status, 404)
    assert.equal(response.json.error.code, 'HOST_NOT_FOUND')
  } finally {
    await node.stop()
  }
})

test('request bodies flow to the Host in multiple tunnel frames', async () => {
  const node = await startNode()
  try {
    const { paired, host } = await pairAndConnect(node)
    const payload = randomBytes(100_000)
    const pending = api(node.baseUrl, 'POST', '/api/echo', {
      cookie: paired.cookie,
      rawBody: payload,
      contentType: 'application/octet-stream',
    })
    const entry = await host.nextOfType('http.request')
    const request = requestFrame(entry)
    assert.equal(request.method, 'POST')
    assert.equal(request.path, '/api/echo')
    assert.equal(request.headers['content-type'], 'application/octet-stream')

    const collected = await collectBody(host, request.id)
    assert.equal(collected.body.length, payload.length)
    assert.ok(collected.body.equals(payload))
    assert.ok(collected.frames >= 2, `expected the body to be split across frames, got ${collected.frames}`)

    sendJson(host, request.id, 200, { received: collected.body.length })
    const response = await pending
    assert.equal(response.status, 200)
    assert.equal(response.json.received, payload.length)
  } finally {
    await node.stop()
  }
})

test('SSE responses stream to the device before the tunnel request ends', async () => {
  const node = await startNode()
  try {
    const { paired, host } = await pairAndConnect(node)
    const port = nodePort(node)
    let status = 0
    let headers: IncomingHttpHeaders = {}
    let body = ''
    let firstChunkSeen = false
    let resolveFirst: () => void = () => undefined
    const firstChunk = new Promise<void>(resolve => {
      resolveFirst = resolve
    })
    const finished = new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/api/events',
          headers: { host: `127.0.0.1:${port}`, cookie: paired.cookie, accept: 'text/event-stream' },
        },
        res => {
          status = res.statusCode ?? 0
          headers = res.headers
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            body += chunk
            if (!firstChunkSeen) {
              firstChunkSeen = true
              resolveFirst()
            }
          })
          res.on('end', () => resolve())
          res.on('error', reject)
        },
      )
      req.on('error', reject)
      req.end()
    })

    const entry = await host.nextOfType('http.request')
    const request = requestFrame(entry)
    assert.equal(request.path, '/api/events')
    host.send({
      t: 'http.response',
      id: request.id,
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    })
    host.send({ t: 'http.chunk', id: request.id }, Buffer.from('data: one\n\n', 'utf8'))
    await firstChunk
    assert.equal(status, 200)
    assert.equal(headers['content-type'], 'text/event-stream')
    assert.equal(body, 'data: one\n\n')

    host.send({ t: 'http.chunk', id: request.id }, Buffer.from('data: two\n\n', 'utf8'))
    await delay(30)
    host.send({ t: 'http.chunk', id: request.id }, Buffer.from('data: three\n\n', 'utf8'))
    host.send({ t: 'http.end', id: request.id })
    await finished
    assert.equal(body, 'data: one\n\ndata: two\n\ndata: three\n\n')
  } finally {
    await node.stop()
  }
})

test('a paired device gets the Host UI at / while the landing page stays on the node', async () => {
  const node = await startNode()
  try {
    const { paired, host } = await pairAndConnect(node)
    assert.equal(host.count('http.request'), 0)
    const pending = api(node.baseUrl, 'GET', '/', { cookie: paired.cookie })
    const entry = await host.nextOfType('http.request')
    const request = requestFrame(entry)
    assert.equal(request.path, '/')
    sendResponse(host, request.id, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<!doctype html><title>DSH</title>',
    })
    const response = await pending
    assert.equal(response.status, 200)
    assert.equal(response.text, '<!doctype html><title>DSH</title>')

    const landing = await api(node.baseUrl, 'GET', '/')
    assert.equal(landing.status, 200)
    assert.match(String(landing.headers.get('content-type')), /text\/html/u)
  } finally {
    await node.stop()
  }
})

test('an offline Host produces the exact "no local response" 503', async () => {
  const node = await startNode()
  try {
    const paired = await completePairing(node)
    paired.hostClient.close()
    await paired.hostClient.waitOffline()
    assert.deepEqual(node.app.services.tunnel.onlineHostIds(), [])

    const response = await api(node.baseUrl, 'GET', '/api/hello', { cookie: paired.cookie })
    assert.equal(response.status, 503)
    assert.equal(response.json.error.code, 'HOST_OFFLINE')
    assert.equal(response.json.error.message, '公网节点已连接，但本机没有响应。请确认 DSH 正在运行。')
  } finally {
    await node.stop()
  }
})

test('a device cannot reach a different online Host after its paired Host disconnects', async () => {
  const node = await startNode()
  try {
    const paired = await completePairing(node)
    paired.hostClient.close()
    await paired.hostClient.waitOffline()
    const unrelated = await registerHost(node, hostRegistration())
    await TestHost.connect(node, unrelated)
    const response = await api(node.baseUrl, 'GET', '/api/hello', { cookie: paired.cookie })
    assert.equal(response.status, 503)
    assert.equal(response.json.error.code, 'HOST_OFFLINE')
  } finally { await node.stop() }
})

test('upgraded Host receives the authenticated relay identity and revocation after reconnect', async () => {
  const node = await startNode()
  try {
    const paired = await completePairing(node)
    paired.hostClient.close()
    await paired.hostClient.waitOffline()
    const host = await TestHost.connect(node, paired.host, true)
    const pending = api(node.baseUrl, 'GET', '/rc/direct/signal', { cookie: paired.cookie })
    const request = requestFrame(await host.nextOfType('http.request'))
    assert.deepEqual(request.relayDevice, { id: paired.client.deviceId, name: paired.client.name })
    sendResponse(host, request.id, { status: 204 })
    assert.equal((await pending).status, 204)
    host.close()
    await host.waitOffline()
    const revoke = await api(node.baseUrl, 'DELETE', `/v1/hosts/${paired.hostId}/devices/${paired.client.deviceId}`, { cookie: paired.cookie })
    assert.equal(revoke.status, 200)
    const reconnected = await TestHost.connect(node, paired.host, true)
    const notice = await reconnected.nextOfType('pair.revoked')
    assert.deepEqual(notice.frame, { t: 'pair.revoked', clientDeviceId: paired.client.deviceId })
  } finally {
    await node.stop()
  }
})

test('a tunnel going away mid-request fails the request without killing the node', async () => {
  const node = await startNode()
  try {
    const { paired, host } = await pairAndConnect(node)
    const pending = api(node.baseUrl, 'GET', '/api/slow', { cookie: paired.cookie })
    await host.nextOfType('http.request')
    host.ws.terminate()

    const response = await pending
    assert.equal(response.status, 502)
    assert.equal(response.json.error.code, 'TUNNEL_CLOSED')
    assert.equal(response.json.error.message, '隧道已断开，请重试。')

    const health = await api(node.baseUrl, 'GET', '/healthz')
    assert.equal(health.status, 200)
    assert.equal(health.json.ok, true)
  } finally {
    await node.stop()
  }
})

test('WebSocket upgrades are proxied to the Host and frames echo back', async () => {
  const node = await startNode()
  try {
    const { paired, host } = await pairAndConnect(node)
    const port = nodePort(node)
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: { cookie: paired.cookie } })
    const messages: Buffer[] = []
    client.on('message', data => messages.push(Buffer.from(data as Buffer)))
    client.on('error', () => undefined)
    const opened = await host.nextOfType('ws.open')
    assert.equal(opened.frame.t, 'ws.open')
    const openFrame = opened.frame as Extract<TunnelFrame, { t: 'ws.open' }>
    assert.equal(openFrame.path, '/api/ws')
    assert.match(String(openFrame.headers.cookie), /dsh_session=/u)
    host.send({ t: 'ws.ack', id: openFrame.id, ok: true })
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve())
      client.once('error', reject)
    })

    client.send(Buffer.from('hello tunnel', 'utf8'))
    const forwarded = await host.next(frame => frame.t === 'ws.frame')
    assert.equal(forwarded.frame.t, 'ws.frame')
    const forwardedFrame = forwarded.frame as Extract<TunnelFrame, { t: 'ws.frame' }>
    assert.equal(forwardedFrame.binary, true)
    assert.equal(forwarded.payload.toString('utf8'), 'hello tunnel')

    host.send({ t: 'ws.frame', id: openFrame.id, binary: true }, Buffer.from('echoed', 'utf8'))
    const deadline = Date.now() + 5_000
    while (messages.length === 0) {
      if (Date.now() > deadline) throw new Error('the client did not receive the echoed frame')
      await delay(10)
    }
    assert.equal(messages[0].toString('utf8'), 'echoed')
    client.close()
  } finally {
    await node.stop()
  }
})

test('cached assets win over the tunnel and missing ones fall back to the Host', async () => {
  const node = await startNode()
  try {
    const { paired, host } = await pairAndConnect(node)
    const upload = await api(
      node.baseUrl,
      'PUT',
      `/v1/assets?rev=${encodeURIComponent('r1')}&path=${encodeURIComponent('/index.html')}`,
      { token: paired.host.credential, rawBody: '<html>cached</html>', contentType: 'text/html' },
    )
    assert.equal(upload.status, 201)

    const cached = await api(node.baseUrl, 'GET', `/assets/${paired.hostId}/r1/index.html`, { cookie: paired.cookie })
    assert.equal(cached.status, 200)
    assert.equal(cached.text, '<html>cached</html>')
    assert.equal(host.count('http.request'), 0, 'a cached asset must not reach the Host')

    const pending = api(node.baseUrl, 'GET', `/assets/${paired.hostId}/r1/next.js`, { cookie: paired.cookie })
    const entry = await host.nextOfType('http.request')
    const request = requestFrame(entry)
    assert.equal(request.path, `/assets/${paired.hostId}/r1/next.js`)
    sendResponse(host, request.id, {
      status: 200,
      headers: { 'content-type': 'application/javascript', 'content-length': '19' },
      body: 'console.log("host")',
    })
    const fallback = await pending
    assert.equal(fallback.status, 200)
    assert.equal(fallback.text, 'console.log("host")')
  } finally {
    await node.stop()
  }
})

test('unpaired devices always get 401 AUTH_REQUIRED outside the node namespace', async () => {
  const node = await startNode()
  try {
    for (const path of ['/api/hello', '/some/deep/path']) {
      const response = await api(node.baseUrl, 'GET', path)
      assert.equal(response.status, 401, `expected 401 for ${path}`)
      assert.equal(response.json.error.code, 'AUTH_REQUIRED')
      assert.equal(response.json.error.message, '请先完成设备配对后再访问此节点。')
    }
    const landing = await api(node.baseUrl, 'GET', '/')
    assert.equal(landing.status, 200)
  } finally {
    await node.stop()
  }
})

test('an oversized tunnel frame closes the Host tunnel without killing the node', async () => {
  const node = await startNode()
  try {
    const { paired, host } = await pairAndConnect(node)
    const header = Buffer.from(
      JSON.stringify({ t: 'http.response', id: 'oversized', status: 200, headers: {} }),
      'utf8',
    )
    const payload = Buffer.alloc(49 * 1024, 0x61)
    const message = Buffer.alloc(4 + header.length + payload.length)
    message.writeUInt32BE(header.length, 0)
    header.copy(message, 4)
    payload.copy(message, 4 + header.length)
    assert.ok(message.length < 64 * 1024)
    host.ws.send(message)

    const closed = await host.waitClose()
    assert.ok(closed.code === 1009 || closed.code === 1006, `unexpected close code ${closed.code}`)

    const health = await api(node.baseUrl, 'GET', '/healthz')
    assert.equal(health.status, 200)
    assert.equal(node.app.services.tunnel.isHostOnline(paired.hostId), false)

    // The node still accepts a fresh tunnel after dropping the oversized frame.
    const replacement = await TestHost.connect(node, paired.host)
    assert.equal(node.app.services.tunnel.isHostOnline(paired.hostId), true)
    replacement.close()
  } finally {
    await node.stop()
  }
})

test('a paired device is limited to sixteen concurrent tunnel requests', async () => {
  const node = await startNode()
  try {
    const { paired, host } = await pairAndConnect(node)
    const port = nodePort(node)
    const pending: Array<Promise<HttpClientResult>> = []
    for (let index = 0; index < 16; index += 1) {
      pending.push(httpGet(port, `/api/slow/${index}`, { cookie: paired.cookie }))
    }
    const deadline = Date.now() + 5_000
    while (host.count('http.request') < 16) {
      if (Date.now() > deadline) throw new Error(`only ${host.count('http.request')} tunnel requests arrived`)
      await delay(10)
    }

    const overflow = await api(node.baseUrl, 'GET', '/api/too-many', { cookie: paired.cookie })
    assert.equal(overflow.status, 429)
    assert.equal(overflow.json.error.code, 'TOO_MANY_REQUESTS')
    assert.equal(overflow.json.error.message, '隧道请求过多，请稍后再试。')

    host.terminate()
    const results = await Promise.allSettled(pending)
    for (const result of results) {
      assert.equal(result.status, 'fulfilled')
      if (result.status === 'fulfilled') assert.equal(result.value.status, 502)
    }
  } finally {
    await node.stop()
  }
})

test('a newer tunnel connection replaces the previous one with close code 4001', async () => {
  const node = await startNode()
  try {
    const { paired, host: first } = await pairAndConnect(node)
    const second = await TestHost.connect(node, paired.host)
    const closed = await first.waitClose()
    assert.equal(closed.code, 4001)
    assert.equal(node.app.services.tunnel.isHostOnline(paired.host.host.hostId), true)
    second.close()
  } finally {
    await node.stop()
  }
})

test('the tunnel endpoint rejects an unknown Host credential', async () => {
  const node = await startNode()
  try {
    const status = await new Promise<number>(resolve => {
      const ws = new WebSocket(`${node.baseUrl.replace(/^http/u, 'ws')}/v1/tunnel`, {
        headers: { authorization: 'Bearer this-is-not-a-real-host-credential' },
      })
      ws.on('unexpected-response', (_req, res) => {
        const code = res.statusCode ?? 0
        res.resume()
        ws.terminate()
        resolve(code)
      })
      ws.on('open', () => {
        ws.terminate()
        resolve(-1)
      })
      ws.on('error', () => {
        // A transport error is always followed by close.
      })
      ws.on('close', () => resolve(-1))
    })
    assert.equal(status, 401)
    assert.equal(node.app.services.tunnel.onlineHostIds().length, 0)
  } finally {
    await node.stop()
  }
})
