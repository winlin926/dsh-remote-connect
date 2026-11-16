import { createHash } from 'node:crypto'
import type { Config } from './config.js'
import { ApiError } from './errors.js'
import type { AssetRow, Repositories } from './repositories.js'

export interface StoredAsset {
  hostId: string
  revision: string
  path: string
  contentType: string
  etag: string
  size: number
  content: Uint8Array
}

export interface AssetResponse {
  etag: string
  contentType: string
  cacheControl: string
  body: Uint8Array
  notModified: boolean
}

const HTML_PATTERN = /\.html?$/iu
const MANIFEST_PATTERN = /(?:^|\/)(?:manifest|asset-manifest)[^/]*\.json$/iu
const ALLOWED_PATH_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,512}$/u

function normalizeAssetPath(raw: string): string {
  if (!raw.startsWith('/')) throw ApiError.badRequest('INVALID_PATH', 'Asset path must start with "/".')
  if (!ALLOWED_PATH_PATTERN.test(raw)) throw ApiError.badRequest('INVALID_PATH', 'Asset path contains invalid characters.')
  if (raw.includes('//') || raw.split('/').some(segment => segment === '..' || segment === '.')) {
    throw ApiError.badRequest('INVALID_PATH', 'Asset path must be normalized.')
  }
  return raw
}

/**
 * Static asset bridge: Hosts push the official DSH web bundle, browsers fetch it
 * by `hid` + `rev`. ETags are scoped to host/revision/path so two Hosts can
 * never share a cache entry.
 */
export class AssetService {
  constructor(
    private readonly repos: Repositories,
    private readonly config: Config,
  ) {}

  put(input: {
    hostId: string
    revision: string
    path: string
    contentType: string
    body: Uint8Array
  }): StoredAsset {
    const path = normalizeAssetPath(input.path)
    if (input.body.byteLength > this.config.assetMaxBytes) {
      throw ApiError.payloadTooLarge(
        'ASSET_TOO_LARGE',
        `Asset exceeds the ${this.config.assetMaxBytes} byte limit.`,
      )
    }
    const contentType = input.contentType.trim().toLowerCase()
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(contentType)) {
      throw ApiError.badRequest('INVALID_CONTENT_TYPE', 'contentType must be a valid MIME type.')
    }
    const etag = this.etagFor(input.hostId, input.revision, path, input.body)
    const now = Date.now()
    this.repos.upsertAsset({
      hostId: input.hostId,
      revision: input.revision,
      path,
      contentType,
      etag,
      size: input.body.byteLength,
      content: input.body,
      now,
    })
    return {
      hostId: input.hostId,
      revision: input.revision,
      path,
      contentType,
      etag,
      size: input.body.byteLength,
      content: input.body,
    }
  }

  get(hostId: string, revision: string, path: string, ifNoneMatch: string | null): AssetResponse | null {
    const row = this.repos.findAsset(hostId, revision, path)
    if (!row) return null
    const notModified = ifNoneMatch !== null && ifNoneMatch.split(',').some(tag => tag.trim() === row.etag)
    return {
      etag: row.etag,
      contentType: row.content_type,
      cacheControl: this.cacheControlFor(row.path),
      body: row.content,
      notModified,
    }
  }

  cacheControlFor(path: string): string {
    if (MANIFEST_PATTERN.test(path)) return 'no-cache'
    if (HTML_PATTERN.test(path)) return 'no-store'
    return 'public, max-age=31536000, immutable'
  }

  private etagFor(hostId: string, revision: string, path: string, body: Uint8Array): string {
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
}

export type { AssetRow }
