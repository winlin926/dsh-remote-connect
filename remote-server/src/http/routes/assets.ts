import { ASSET_REVISION_PATTERN } from '../../contract.js'
import { ApiError, rateLimited } from '../../errors.js'
import type { AppServices } from '../../services.js'
import type { RouteContext, Router } from '../router.js'
import { baseHeaders, readRawBody, sendBuffer, sendJson } from '../util.js'

const HOST_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u

function ifNoneMatchFrom(ctx: RouteContext): string | null {
  const raw = ctx.req.headers['if-none-match']
  return Array.isArray(raw) ? raw[0] ?? null : raw ?? null
}

/**
 * Static asset bridge. Hosts push the official DSH bundle; browsers read it by
 * `hid` + `rev`, and cache entries are keyed by Host so two Hosts can never
 * collide in an intermediate cache.
 */
export function registerAssetRoutes(router: Router, services: AppServices): void {
  const { config, auth, assets, limiter } = services

  router.add('PUT', '/v1/assets', async ctx => {
    const host = auth.authenticateHostRequest(ctx.req)
    const decision = limiter.take('asset-upload', host.host_id, { ratePerSecond: 8, burst: 64 })
    if (!decision.allowed) throw rateLimited(decision.retryAfterMs)
    const revision = ctx.url.searchParams.get('rev') ?? ''
    if (!ASSET_REVISION_PATTERN.test(revision)) {
      throw ApiError.badRequest('INVALID_REVISION', 'rev must match /^[A-Za-z0-9._-]{1,64}$/u.')
    }
    const path = ctx.url.searchParams.get('path') ?? ''
    const contentType = String(ctx.req.headers['content-type'] ?? 'application/octet-stream')
    let body: Uint8Array
    try {
      body = await readRawBody(ctx.req, config.assetMaxBytes)
    } catch (error) {
      if (error instanceof ApiError && error.status === 413) {
        throw ApiError.payloadTooLarge('ASSET_TOO_LARGE', `Assets must be at most ${config.assetMaxBytes} bytes.`)
      }
      throw error
    }
    const stored = assets.put({ hostId: host.host_id, revision, path, contentType, body })
    sendJson(
      ctx.res,
      201,
      { ok: true, path: stored.path, revision: stored.revision, etag: stored.etag, size: stored.size },
      { head: ctx.head },
    )
  })

  const serveAsset = (ctx: RouteContext): void => {
    const hostId = ctx.params.hid ?? ''
    const revision = ctx.params.rev ?? ''
    if (!HOST_ID_PATTERN.test(hostId)) {
      throw ApiError.badRequest('INVALID_HOST_ID', 'hid must be a base64url Host id.')
    }
    if (!ASSET_REVISION_PATTERN.test(revision)) {
      throw ApiError.badRequest('INVALID_REVISION', 'rev must match /^[A-Za-z0-9._-]{1,64}$/u.')
    }
    const assetPath = `/${ctx.params['*'] ?? ''}`
    const asset = assets.get(hostId, revision, assetPath, ifNoneMatchFrom(ctx))
    if (!asset) throw ApiError.notFound('ASSET_NOT_FOUND', 'The asset is not available on this node.')
    if (asset.notModified) {
      ctx.res.writeHead(304, {
        ...baseHeaders(),
        etag: asset.etag,
        'cache-control': asset.cacheControl,
      })
      ctx.res.end()
      return
    }
    sendBuffer(ctx.res, 200, asset.body, {
      contentType: asset.contentType,
      cacheControl: asset.cacheControl,
      etag: asset.etag,
      head: ctx.head,
    })
  }

  router.add('GET', '/assets/:hid/:rev/*', serveAsset)
  router.add('HEAD', '/assets/:hid/:rev/*', serveAsset)
}
