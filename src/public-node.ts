/**
 * Public node discovery: a user enters one HTTPS address, and this protocol answers whether the
 * address is a DSH gateway (a domain tunnelled to this computer's gateway) or a self-hosted
 * service (a remote-server). Gateway and service share the same document shape, so the rest of
 * the plugin never has to know which one it is talking to.
 *
 * Two protocol versions are accepted. Protocol 1 names one Host identity with flat `hostId` and
 * `fingerprint` fields. Protocol 2 names the node with a self-certifying `node` object
 * (`id`/`fingerprint`/`publicKey`); a gateway also repeats the flat fields as a compatibility
 * alias for protocol-1 clients, while a protocol-2 service node must not send them.
 */
import { createPublicKey } from 'node:crypto'
import { identityOfPublicKey } from './host-identity.js'

/** The only discovery path; the exact path is also the gateway's only unpaired route. */
export const PUBLIC_NODE_PATH = '/.well-known/dsh-remote'
/** Protocol 1: one flat Host identity; the original document shape. */
export const PUBLIC_NODE_PROTOCOL_V1 = 1
/** Protocol 2: a self-certifying node identity. Clients that do not know it refuse the node. */
export const PUBLIC_NODE_PROTOCOL_V2 = 2
export type PublicNodeProtocol = 1 | 2
/** Discovery doubles as a reachability check; a node slower than this is unusable for the check. */
export const PUBLIC_NODE_TIMEOUT = 5000
/** `name` as a person reads it, counted in Unicode code points. */
export const NODE_NAME_MAX = 64

export type PublicNodeKind = 'gateway' | 'service'
export type PublicNodeCapability = 'pairing' | 'cache' | 'official-ui'
/** Exact lowercase spellings; an unknown capability fails detection so a new one needs a protocol bump. */
export const PUBLIC_NODE_CAPABILITIES: readonly PublicNodeCapability[] = ['pairing', 'cache', 'official-ui']

/** Host identity encodings; see `host-identity.ts` for how a node derives them. */
export const HOST_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/
export const FINGERPRINT_PATTERN = /^[a-f0-9]{32}$/
/** An Ed25519 SPKI DER in base64url: 40–120 URL-safe characters before the self-check. */
export const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{40,120}$/
/** 1–32 ASCII characters, starting with a letter or digit: a semver fits, prose and spaces do not. */
export const NODE_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export function isPublicNodeKind(value: unknown): value is PublicNodeKind {
  return value === 'gateway' || value === 'service'
}

export function isPublicNodeCapability(value: unknown): value is PublicNodeCapability {
  return typeof value === 'string' && (PUBLIC_NODE_CAPABILITIES as readonly string[]).includes(value)
}

export function isPublicNodeProtocol(value: unknown): value is PublicNodeProtocol {
  return value === PUBLIC_NODE_PROTOCOL_V1 || value === PUBLIC_NODE_PROTOCOL_V2
}

/** 1–64 Unicode code points, no C0/C1 control characters. */
export function isPublicNodeName(value: unknown): value is string {
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) return false
  const length = [...value].length
  return length >= 1 && length <= NODE_NAME_MAX
}

/** The public half of one node: two encodings of sha256(SPKI DER) plus the key itself. */
export interface PublicNodeIdentity {
  /** base64url(sha256(SPKI DER)), exactly 43 characters. */
  id: string
  /** The first 16 digest bytes as lowercase hex, exactly 32 characters. */
  fingerprint: string
  /** SPKI DER, base64url; public and safe to publish. */
  publicKey: string
}

/** What two discovery documents can be compared by: a protocol-2 node or protocol-1 flat fields. */
export interface PublicNodeIdentityFields {
  id: string
  fingerprint: string
}

/** The document at {@link PUBLIC_NODE_PATH}. Field order is not significant to clients. */
export interface PublicNodeDiscovery {
  protocol: PublicNodeProtocol
  kind: PublicNodeKind
  name: string
  version: string
  capabilities: PublicNodeCapability[]
  /** Protocol 2 only; null on a protocol-1 document. */
  node: PublicNodeIdentity | null
  /** Protocol 1 only; null on a protocol-2 document (a gateway also sends aliases, which are dropped). */
  hostId: string | null
  /** Protocol 1 only; see `hostId`. */
  fingerprint: string | null
}

/** A discovery document whose address was validated; `url` is the normalized origin. */
export interface DetectedPublicNode extends PublicNodeDiscovery { url: string }

export type PublicNodeErrorCode =
  | 'not-https'
  | 'bad-url'
  | 'unreachable'
  | 'redirect'
  | 'bad-tls'
  | 'bad-protocol'
  | 'bad-kind'
  | 'bad-capability'
  | 'bad-identity'
  | 'bad-response'

export interface PublicNodeFailure { ok: false; code: PublicNodeErrorCode; message: string }
export interface PublicNodeSuccess { ok: true; node: DetectedPublicNode }
export type PublicNodeDetection = PublicNodeSuccess | PublicNodeFailure

/** Injected in tests only; production always uses the process-wide fetch. */
export type PublicNodeFetch = (url: string, init: RequestInit) => Promise<Response>
export interface DetectPublicNodeOptions { fetch?: PublicNodeFetch; timeoutMs?: number }

function failure(code: PublicNodeErrorCode, message: string): PublicNodeFailure { return { ok: false, code, message } }

/** Structural pattern check only: it says the fields look like one identity, not that the key derives them. */
export function isPublicNodeIdentity(value: unknown): value is PublicNodeIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return typeof row.id === 'string' && HOST_ID_PATTERN.test(row.id)
    && typeof row.fingerprint === 'string' && FINGERPRINT_PATTERN.test(row.fingerprint)
    && typeof row.publicKey === 'string' && PUBLIC_KEY_PATTERN.test(row.publicKey)
}

/**
 * Decode a node identity and prove it: the Ed25519 SPKI DER must parse, and sha256 over that DER
 * must reproduce both `id` and `fingerprint`. A document that merely copies plausible strings is
 * not a node identity. Returns null on any mismatch.
 */
export function parsePublicNodeIdentity(value: unknown): PublicNodeIdentity | null {
  if (!isPublicNodeIdentity(value)) return null
  let der: Buffer
  try {
    der = Buffer.from(value.publicKey, 'base64url')
    // Only the canonical base64url spelling of these bytes is accepted, so one key has one encoding.
    if (der.toString('base64url') !== value.publicKey) return null
    if (createPublicKey({ key: der, format: 'der', type: 'spki' }).asymmetricKeyType !== 'ed25519') return null
  } catch { return null }
  const derived = identityOfPublicKey(der)
  if (derived.hostId !== value.id || derived.fingerprint !== value.fingerprint) return null
  return { id: derived.hostId, fingerprint: derived.fingerprint, publicKey: value.publicKey }
}

/**
 * The identity a discovery document names: a protocol-2 `node` first, protocol-1 flat fields as
 * the fallback. Works on raw JSON as well as a parsed document, so callers comparing a live node
 * against an expected identity do not have to trust either shape.
 */
export function nodeIdentityOf(document: unknown): PublicNodeIdentityFields | null {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null
  const row = document as Record<string, unknown>
  const node = row.node
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const fields = node as Record<string, unknown>
    if (typeof fields.id === 'string' && HOST_ID_PATTERN.test(fields.id) && typeof fields.fingerprint === 'string' && FINGERPRINT_PATTERN.test(fields.fingerprint)) return { id: fields.id, fingerprint: fields.fingerprint }
  }
  if (typeof row.hostId === 'string' && HOST_ID_PATTERN.test(row.hostId) && typeof row.fingerprint === 'string' && FINGERPRINT_PATTERN.test(row.fingerprint)) return { id: row.hostId, fingerprint: row.fingerprint }
  return null
}

type AddressResult = { ok: true; origin: string } | PublicNodeFailure
/** The address is an origin and nothing else: a path, query, fragment or userinfo would name a different resource. */
function parseAddress(input: string | URL): AddressResult {
  let url: URL
  if (input instanceof URL) url = new URL(input.href)
  else {
    const text = String(input ?? '').trim()
    if (!text) return failure('bad-url', '公网节点地址不能为空。')
    try { url = new URL(text) } catch { return failure('bad-url', '公网节点地址格式无效，请填写完整的 https:// 地址。') }
  }
  if (url.protocol !== 'https:') return failure('not-https', '公网节点必须使用 https:// 地址。')
  if (url.username || url.password) return failure('bad-url', '公网节点地址不能包含账号或密码。')
  if (url.pathname !== '/' || url.search || url.hash) return failure('bad-url', '公网节点地址只能是域名，不能带路径、查询参数或锚点。')
  return { ok: true, origin: url.origin }
}

/** The normalized origin of a node address, or null when it is not a bare HTTPS origin. */
export function normalizeNodeOrigin(input: string | URL): string | null {
  const parsed = parseAddress(input)
  return parsed.ok ? parsed.origin : null
}

/** A transport failure is a certificate failure only when the cause chain says so; everything else is reachability. */
function transportFailure(error: unknown): PublicNodeFailure {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    parts.push(current.name, current.message, String((current as NodeJS.ErrnoException).code ?? ''))
    current = (current as { cause?: unknown }).cause
  }
  return /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|ALTNAME|HOSTNAME_MISMATCH/i.test(parts.join(' '))
    ? failure('bad-tls', '公网节点的 TLS 证书无效或不受信任。')
    : failure('unreachable', '无法连接公网节点：网络不可达，或域名没有指向正在运行的节点。')
}

function validateDiscovery(origin: string, input: unknown): PublicNodeDetection {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return failure('bad-response', '节点发现接口的响应不是 JSON 对象。')
  const body = input as Record<string, unknown>
  if (!isPublicNodeProtocol(body.protocol)) return failure('bad-protocol', '节点协议版本无效：只支持 1 和 2。')
  if (!isPublicNodeKind(body.kind)) return failure('bad-kind', '节点类型无效：只能是 gateway 或 service。')
  if (!isPublicNodeName(body.name)) return failure('bad-response', '节点名称无效：需要 1–64 个字符。')
  if (typeof body.version !== 'string' || !NODE_VERSION_PATTERN.test(body.version)) return failure('bad-response', '节点版本号无效：需要 1–32 位字母、数字或 . + _ - 组成的字符串。')
  if (!Array.isArray(body.capabilities) || body.capabilities.length === 0) return failure('bad-capability', '节点能力列表无效。')
  const capabilities: PublicNodeCapability[] = []
  for (const item of body.capabilities) { if (!isPublicNodeCapability(item)) return failure('bad-capability', `节点能力列表包含未知能力：${String(item)}。`); capabilities.push(item) }
  if (!capabilities.includes('pairing')) return failure('bad-capability', '节点能力列表缺少必需的 pairing。')
  const shared = { protocol: body.protocol, kind: body.kind, name: body.name, version: body.version, capabilities: [...new Set(capabilities)] }
  if (body.protocol === PUBLIC_NODE_PROTOCOL_V1) {
    if (typeof body.hostId !== 'string' || !HOST_ID_PATTERN.test(body.hostId)) return failure('bad-identity', '节点身份无效：hostId 必须是 43 位 base64url。')
    if (typeof body.fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(body.fingerprint)) return failure('bad-identity', '节点身份无效：fingerprint 必须是 32 位小写十六进制。')
    return { ok: true, node: { ...shared, node: null, hostId: body.hostId, fingerprint: body.fingerprint, url: origin } }
  }
  // Protocol 2: the flat fields are compatibility aliases for old clients and are deliberately
  // neither validated nor returned here; `node` is the one identity this plugin records.
  if (!body.node || typeof body.node !== 'object' || Array.isArray(body.node)) return failure('bad-identity', '节点身份无效：协议 2 的发现文档缺少 node 身份对象。')
  const node = parsePublicNodeIdentity(body.node)
  if (!node) return failure('bad-identity', '节点身份无效：publicKey 必须是有效的 Ed25519 公钥，且其 sha256 必须同时等于 id 与 fingerprint。')
  return { ok: true, node: { ...shared, node, hostId: null, fingerprint: null, url: origin } }
}

/**
 * Probe one address and classify what is behind it. Every failure is returned as data with a
 * Chinese reason; a caller never has to guard against a throw from here.
 */
export async function detectPublicNode(input: string | URL, options: DetectPublicNodeOptions = {}): Promise<PublicNodeDetection> {
  const parsed = parseAddress(input)
  if (!parsed.ok) return parsed
  const fetcher = options.fetch ?? ((url: string, init: RequestInit) => globalThis.fetch(url, init))
  const timeoutMs = options.timeoutMs ?? PUBLIC_NODE_TIMEOUT
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const timeoutFailure = () => failure('unreachable', '探测超时：公网节点没有及时响应。')
  try {
    let response: Response
    try {
      response = await fetcher(parsed.origin + PUBLIC_NODE_PATH, {
        method: 'GET', redirect: 'manual', signal: controller.signal, credentials: 'omit', cache: 'no-store',
        // No cookie and no referer: a discovery request must not carry a pairing session or reveal where it came from.
        headers: { accept: 'application/json' }, referrerPolicy: 'no-referrer',
      })
    } catch (error) { return timedOut ? timeoutFailure() : transportFailure(error) }
    // Undici reports the 3xx itself, browsers may hand back an opaque redirect; both mean "refused".
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) return failure('redirect', '公网节点不允许重定向：发现请求不跟随任何 3xx。')
    if (response.status !== 200) return failure('bad-response', `节点发现接口返回 HTTP ${response.status}。`)
    let body: unknown
    try { body = await response.json() } catch { return timedOut ? timeoutFailure() : failure('bad-response', '节点发现接口没有返回有效的 JSON。') }
    if (timedOut) return timeoutFailure()
    return validateDiscovery(parsed.origin, body)
  } finally { clearTimeout(timer) }
}
