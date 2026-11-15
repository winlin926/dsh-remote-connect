/**
 * Public node discovery: a user enters one HTTPS address, and this protocol answers whether the
 * address is a DSH gateway (a domain tunnelled to this computer's gateway) or a self-hosted
 * service (a remote-server). Gateway and service share the same document shape, so the rest of
 * the plugin never has to know which one it is talking to.
 */

/** The only discovery path; the exact path is also the gateway's only unpaired route. */
export const PUBLIC_NODE_PATH = '/.well-known/dsh-remote'
/** Changing this number is a breaking change: clients refuse any other value instead of guessing. */
export const PUBLIC_NODE_PROTOCOL = 1
/** Discovery doubles as a reachability check; a node slower than this is unusable for the check. */
export const PUBLIC_NODE_TIMEOUT = 5000
/** `name` as a person reads it, counted in Unicode code points. */
export const NODE_NAME_MAX = 64

export type PublicNodeKind = 'gateway' | 'service'
export type PublicNodeCapability = 'pairing' | 'cache' | 'official-ui' | 'relay' | 'turn'
export const PUBLIC_NODE_KINDS: readonly PublicNodeKind[] = ['gateway', 'service']
/** Exact lowercase spellings; an unknown capability fails detection so a new one needs a protocol bump. */
export const PUBLIC_NODE_CAPABILITIES: readonly PublicNodeCapability[] = ['pairing', 'cache', 'official-ui', 'relay', 'turn']

/** Host identity encodings; see `host-identity.ts` for how a node derives them. */
export const HOST_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/
export const FINGERPRINT_PATTERN = /^[a-f0-9]{32}$/
/** 1–32 ASCII characters, starting with a letter or digit: a semver fits, prose and spaces do not. */
export const NODE_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/
/** A content revision: the same alphabet the Host's own asset URLs use. */
export const REVISION_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export function isPublicNodeKind(value: unknown): value is PublicNodeKind {
  return value === 'gateway' || value === 'service'
}

export function isPublicNodeCapability(value: unknown): value is PublicNodeCapability {
  return typeof value === 'string' && (PUBLIC_NODE_CAPABILITIES as readonly string[]).includes(value)
}

/** 1–64 Unicode code points, no C0/C1 control characters. */
export function isPublicNodeName(value: unknown): value is string {
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) return false
  const length = [...value].length
  return length >= 1 && length <= NODE_NAME_MAX
}

/** The document at {@link PUBLIC_NODE_PATH}. Field order is not significant to clients. */
export interface PublicNodeDiscovery {
  protocol: 1
  kind: PublicNodeKind
  name: string
  version: string
  capabilities: PublicNodeCapability[]
  hostId: string
  fingerprint: string
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
  if (body.protocol !== PUBLIC_NODE_PROTOCOL) return failure('bad-protocol', `节点协议版本不是 ${PUBLIC_NODE_PROTOCOL}。`)
  if (!isPublicNodeKind(body.kind)) return failure('bad-kind', '节点类型无效：只能是 gateway 或 service。')
  if (!isPublicNodeName(body.name)) return failure('bad-response', '节点名称无效：需要 1–64 个字符。')
  if (typeof body.version !== 'string' || !NODE_VERSION_PATTERN.test(body.version)) return failure('bad-response', '节点版本号无效：需要 1–32 位字母、数字或 . + _ - 组成的字符串。')
  if (!Array.isArray(body.capabilities) || body.capabilities.length === 0) return failure('bad-capability', '节点能力列表无效。')
  const capabilities: PublicNodeCapability[] = []
  for (const item of body.capabilities) { if (!isPublicNodeCapability(item)) return failure('bad-capability', `节点能力列表包含未知能力：${String(item)}。`); capabilities.push(item) }
  if (!capabilities.includes('pairing')) return failure('bad-capability', '节点能力列表缺少必需的 pairing。')
  if (typeof body.hostId !== 'string' || !HOST_ID_PATTERN.test(body.hostId)) return failure('bad-identity', '节点身份无效：hostId 必须是 43 位 base64url。')
  if (typeof body.fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(body.fingerprint)) return failure('bad-identity', '节点身份无效：fingerprint 必须是 32 位小写十六进制。')
  return { ok: true, node: { protocol: PUBLIC_NODE_PROTOCOL, kind: body.kind, name: body.name, version: body.version, capabilities: [...new Set(capabilities)], hostId: body.hostId, fingerprint: body.fingerprint, url: origin } }
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

/**
 * Cache partition rule for one Host under one origin. The browser isolates by origin already;
 * within one origin (a service fronting several Hosts) `hid` separates Hosts and `rev` separates
 * builds, so an asset URL can never be answered from another Host's copy.
 */
export interface CacheScopeInput { origin: string; hostId: string; rev: string }
export interface CacheScope {
  origin: string
  hid: string
  rev: string
  /** The exact query fragment to append to every asset URL served for this Host. */
  query: string
  /** Partition key for tests and diagnostics: origin + the two isolation parameters. */
  key: string
}

export function cacheScope(input: CacheScopeInput): CacheScope {
  const origin = normalizeNodeOrigin(input.origin)
  if (!origin) throw new Error('缓存作用域需要不带路径的 HTTPS origin。')
  if (!HOST_ID_PATTERN.test(input.hostId)) throw new Error('缓存作用域需要 43 位 base64url 的 hostId。')
  if (!REVISION_PATTERN.test(input.rev)) throw new Error('缓存作用域需要 1–64 位字母、数字、_ 或 - 的 rev。')
  const query = `hid=${input.hostId}&rev=${input.rev}`
  return { origin, hid: input.hostId, rev: input.rev, query, key: `${origin}?${query}` }
}
