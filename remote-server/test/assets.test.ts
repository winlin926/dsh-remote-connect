import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  api,
  hostRegistration,
  randomDeviceId,
  randomIdentityKey,
  registerHost,
  startNode,
} from './helpers.ts'

function expectedEtag(hostId: string, revision: string, path: string, body: string): string {
  const digest = createHash('sha256')
  digest.update(hostId)
  digest.update('\0')
  digest.update(revision)
  digest.update('\0')
  digest.update(path)
  digest.update('\0')
  digest.update(body)
  return `"${digest.digest('hex').slice(0, 32)}"`
}

function assetUrl(baseUrl: string, hostId: string, revision: string, path: string): string {
  return `${baseUrl}/assets/${hostId}/${revision}${path}`
}

async function upload(
  node: Awaited<ReturnType<typeof startNode>>,
  credential: string,
  revision: string,
  path: string,
  body: string,
  contentType = 'text/plain',
) {
  return api(node.baseUrl, 'PUT', `/v1/assets?rev=${encodeURIComponent(revision)}&path=${encodeURIComponent(path)}`, {
    token: credential,
    rawBody: body,
    contentType,
  })
}

test('a Host can publish revisioned assets that browsers fetch with immutable caching', async () => {
  const node = await startNode()
  const host = await registerHost(node, hostRegistration())
  try {
    const body = 'console.log("dsh")'
    const published = await upload(node, host.credential, 'rev-1', '/app.js', body, 'application/javascript')
    assert.equal(published.status, 201)
    assert.equal(published.json.ok, true)
    assert.equal(published.json.path, '/app.js')
    assert.equal(published.json.revision, 'rev-1')
    assert.equal(published.json.size, Buffer.byteLength(body))
    assert.equal(published.json.etag, expectedEtag(host.host.hostId, 'rev-1', '/app.js', body))

    const fetched = await api(node.baseUrl, 'GET', `/assets/${host.host.hostId}/rev-1/app.js`)
    assert.equal(fetched.status, 200)
    assert.equal(fetched.text, body)
    assert.equal(fetched.headers.get('content-type'), 'application/javascript')
    assert.equal(fetched.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.equal(fetched.headers.get('etag'), published.json.etag)
    assert.equal(fetched.headers.get('x-content-type-options'), 'nosniff')

    const revalidated = await api(node.baseUrl, 'GET', `/assets/${host.host.hostId}/rev-1/app.js`, {
      headers: { 'if-none-match': published.json.etag },
    })
    assert.equal(revalidated.status, 304)
    assert.equal(revalidated.text, '')
    assert.equal(revalidated.headers.get('etag'), published.json.etag)
    assert.equal(revalidated.headers.get('cache-control'), 'public, max-age=31536000, immutable')

    const stale = await api(node.baseUrl, 'GET', `/assets/${host.host.hostId}/rev-1/app.js`, {
      headers: { 'if-none-match': '"00000000000000000000000000000000"' },
    })
    assert.equal(stale.status, 200)

    const head = await api(node.baseUrl, 'HEAD', `/assets/${host.host.hostId}/rev-1/app.js`)
    assert.equal(head.status, 200)
    assert.equal(head.text, '')
    assert.equal(head.headers.get('etag'), published.json.etag)
  } finally {
    await node.stop()
  }
})

test('HTML and manifests are revalidated instead of cached forever', async () => {
  const node = await startNode()
  const host = await registerHost(node, hostRegistration())
  try {
    await upload(node, host.credential, 'r1', '/index.html', '<!doctype html>', 'text/html')
    const html = await api(node.baseUrl, 'GET', `/assets/${host.host.hostId}/r1/index.html`)
    assert.equal(html.status, 200)
    assert.equal(html.headers.get('cache-control'), 'no-store')

    await upload(node, host.credential, 'r1', '/asset-manifest.json', '{}', 'application/json')
    const manifest = await api(node.baseUrl, 'GET', `/assets/${host.host.hostId}/r1/asset-manifest.json`)
    assert.equal(manifest.status, 200)
    assert.equal(manifest.headers.get('cache-control'), 'no-cache')
  } finally {
    await node.stop()
  }
})

test('assets are namespaced per Host and never share cache entries', async () => {
  const node = await startNode()
  const hostA = await registerHost(node, hostRegistration())
  const hostB = await registerHost(node, hostRegistration())
  try {
    const a = await upload(node, hostA.credential, 'r1', '/app.js', 'bundle-a', 'application/javascript')
    const b = await upload(node, hostB.credential, 'r1', '/app.js', 'bundle-b', 'application/javascript')
    assert.equal(a.status, 201)
    assert.equal(b.status, 201)
    assert.notEqual(a.json.etag, b.json.etag, 'identical paths on different Hosts must not share an ETag')

    const readA = await api(node.baseUrl, 'GET', `/assets/${hostA.host.hostId}/r1/app.js`)
    const readB = await api(node.baseUrl, 'GET', `/assets/${hostB.host.hostId}/r1/app.js`)
    assert.equal(readA.text, 'bundle-a')
    assert.equal(readB.text, 'bundle-b')

    const crossed = await api(node.baseUrl, 'GET', `/assets/${hostA.host.hostId}/r1/app.js`, {
      headers: { 'if-none-match': b.json.etag },
    })
    assert.equal(crossed.status, 200, 'another Host ETag must not satisfy this Host asset')
    assert.equal(crossed.text, 'bundle-a')

    const wrongRevision = await api(node.baseUrl, 'GET', `/assets/${hostA.host.hostId}/r2/app.js`)
    assert.equal(wrongRevision.status, 404)
    assert.equal(wrongRevision.json.error.code, 'ASSET_NOT_FOUND')

    const unknownHost = await api(node.baseUrl, 'GET', `/assets/${randomIdentityKey()}/r1/app.js`)
    assert.equal(unknownHost.status, 404)
    assert.equal(unknownHost.json.error.code, 'ASSET_NOT_FOUND')
  } finally {
    await node.stop()
  }
})

test('asset publishing and serving reject damaged input without 500s', async () => {
  const node = await startNode({ ASSET_MAX_BYTES: '1024' })
  const host = await registerHost(node, hostRegistration())
  try {
    const unauthenticated = await upload(node, 'A'.repeat(64), 'r1', '/app.js', 'x')
    assert.equal(unauthenticated.status, 401)
    assert.equal(unauthenticated.json.error.code, 'AUTH_INVALID')

    const noCredential = await api(node.baseUrl, 'PUT', '/v1/assets?rev=r1&path=%2Fapp.js', {
      rawBody: 'x',
      contentType: 'text/plain',
    })
    assert.equal(noCredential.status, 401)
    assert.equal(noCredential.json.error.code, 'AUTH_REQUIRED')

    const missingPath = await api(node.baseUrl, 'PUT', '/v1/assets?rev=r1', {
      token: host.credential,
      rawBody: 'x',
      contentType: 'text/plain',
    })
    assert.equal(missingPath.status, 400)
    assert.equal(missingPath.json.error.code, 'INVALID_PATH')

    const traversal = await upload(node, host.credential, 'r1', '/a/../b', 'x')
    assert.equal(traversal.status, 400)
    assert.equal(traversal.json.error.code, 'INVALID_PATH')

    const badRevision = await upload(node, host.credential, '../r1', '/a', 'x')
    assert.equal(badRevision.status, 400)
    assert.equal(badRevision.json.error.code, 'INVALID_REVISION')

    const oversized = await upload(node, host.credential, 'r1', '/big.bin', 'x'.repeat(4096), 'application/octet-stream')
    assert.equal(oversized.status, 413)
    assert.equal(oversized.json.error.code, 'ASSET_TOO_LARGE')

    const badContentType = await upload(node, host.credential, 'r1', '/a', 'x', 'not a mime type')
    assert.equal(badContentType.status, 400)
    assert.equal(badContentType.json.error.code, 'INVALID_CONTENT_TYPE')

    const badHid = await api(node.baseUrl, 'GET', '/assets/short/r1/app.js')
    assert.equal(badHid.status, 400)
    assert.equal(badHid.json.error.code, 'INVALID_HOST_ID')

    const uploads = await Promise.all(
      Array.from({ length: 70 }, (_, index) => upload(node, host.credential, `rev${index}`, '/app.js', 'x')),
    )
    assert.ok(uploads.some(result => result.status === 429), 'asset uploads must be rate limited')
    const limited = uploads.find(result => result.status === 429)
    assert.equal(limited?.json.error.code, 'RATE_LIMITED')
    assert.ok(Number(limited?.headers.get('retry-after') ?? 0) >= 1)
  } finally {
    await node.stop()
  }
})
