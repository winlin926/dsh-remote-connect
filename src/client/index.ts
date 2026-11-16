import * as React from 'react'
import { CSS } from './style.js'
import { PhoneIcon } from './nav-icon.js'
import { PluginUpdate, resolvePluginManager, updateCard, type PluginManagerFace } from './plugin-update.js'
const h = React.createElement
const ROUTE = '/api/dsh-remote-connect/manage'
const PACKAGE_NAME = '@winlin926/dsh-remote-connect'
/**
 * One update card per page: the check cache has to survive closing and reopening the panel, which
 * unmounts the component but keeps the module alive.
 */
let updateStore: PluginUpdate | null = null
let hostVersion: string | null = null
function updateStoreFor(manager: () => PluginManagerFace | null): PluginUpdate {
  updateStore ??= new PluginUpdate({ packageName: PACKAGE_NAME, manager, installed: () => hostVersion })
  return updateStore
}
export type PublicNodeKind = 'gateway' | 'service'
/** One node identity: protocol 2 carries it, protocol 1 records only keep the flat host pair. */
export interface PublicNodeIdentity { id: string; fingerprint: string; publicKey: string }
/** A protocol 2 node that came back with a different identity; nothing connects until the Host confirms it. */
export interface PublicNodeIdentityChange { from: { id: string; fingerprint: string }; to: { id: string; fingerprint: string }; detectedAt: number }
/** One Host entry the panel can add, probe, choose or remove. */
export interface PublicNode {
  id: string; url: string; kind: PublicNodeKind | null; name: string | null; version: string | null
  protocol: number | null; capabilities: string[] | null; node: PublicNodeIdentity | null; hostId: string | null; fingerprint: string | null
  addedAt: number; lastCheckAt: number | null; lastCheckOk: boolean; lastCheckError: string | null; pending: boolean
  identityChange: PublicNodeIdentityChange | null
}
export interface ServicePairing { requestId: string; deviceName: string; expiresAt: number }
export interface ServiceNodeState { origin: string; connected: boolean; lastError?: string; pendingPairings: ServicePairing[] }
interface Status {
  enabled: boolean; busy: boolean; mode: 'public' | 'lan'; activeMode?: 'public' | 'lan'; autoStart: boolean; proxyConfigured: boolean; proxyMode?: 'system' | 'manual' | 'off'; manualProxy?: string; systemProxy?: { url: string; source: string } | null
  publicUrl?: string | null; publicPort: number
  /** What the public pairing page shows and what the panel confirms: the same name and fingerprint. */
  node: { name: string; kind: 'gateway' | 'service'; protocol: number; fingerprint: string; fingerprintGroups: string }
  /** Why the last pairing attempt was rejected; the panel is the place that has to explain it. */
  pairingFailure?: { at: number; name: string; reason: string }
  /** Authorizations from a public entry recorded before the double-confirmation flow. */
  repairRequired: number
  publicUrlCheck?: { at: number; reachable: boolean; status: number | null; failure: 'unreachable' | 'identity' | 'tls' | null; error: string | null }
  certificate?: { domain?: string; expiresAt?: number; renewAt?: number; selfSigned: boolean; pending: boolean; restartRequired: boolean; error?: string }
  lanTls?: { origin?: string; expiresAt?: number; error?: string }
  phase: string; error?: string; gatewayPort: number; local: boolean; expiresAt?: number; qr?: string
  links: Array<{ base: string; url?: string }>; requests: Array<{ id: string; name: string; via: 'lan' | 'public'; nodeConfirmed: boolean; expiresAt: number }>
  devices: Array<{ id: string; name: string; createdAt: number; lastSeenAt: number; online: boolean; via?: 'lan' | 'public'; requiresRepair?: boolean }>; lanHint: string
  /** Public entries recorded on this Host; the panel adds, probes and chooses among them. */
  publicNodes?: { current: string | null; list: PublicNode[]; pendingReview: boolean }
  /** Present only while this Host is connected through a self-hosted public node. */
  serviceNode?: ServiceNodeState | null
  /** The running plugin version, shown before the plugin manager has answered. */
  version?: string
}
interface ClientContext {
  effect(run: () => void | (() => void), label?: string): void
  /** Resolve a service by name regardless of the property inject gate. */
  get?(name: string): unknown
  slots: { inject(name: string, setup: () => unknown): void; register(meta: Record<string, unknown>, render: (props: any) => unknown): unknown }
}
/** A panel request must never leave the poll or a button waiting forever on a dead network. */
function deadline(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return controller.signal
}
/** An insecure origin (a phone on http://LAN-IP) exposes no clipboard API; the legacy command is the only way to copy there. */
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(text); return true } catch { /* the legacy command below is the fallback */ } }
  const area = document.createElement('textarea')
  area.value = text
  // inputmode=none keeps the soft keyboard closed while the selection satisfies execCommand.
  area.setAttribute('inputmode', 'none'); area.setAttribute('aria-hidden', 'true')
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0'
  document.body.append(area)
  area.focus(); area.setSelectionRange(0, text.length)
  try { return document.execCommand('copy') } catch { return false } finally { area.remove() }
}
export async function command(input: Record<string, unknown>): Promise<Status> {
  const transport = (globalThis as unknown as { __DSH_TRANSPORT__?: { fetch?: typeof fetch } }).__DSH_TRANSPORT__?.fetch ?? fetch
  let response: Response
  try {
    response = await transport(ROUTE, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: deadline(30_000) })
  } catch (failure) {
    const name = (failure as { name?: string } | null)?.name
    throw new Error(name === 'AbortError' || name === 'TimeoutError' ? '和电脑的连接超时，请检查网络后重试。' : failure instanceof Error ? failure.message : '连接失败。')
  }
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? `连接失败（HTTP ${response.status}）`)
  // Node add/probe failures arrive as HTTP 200 with { ok: false, message }; they are errors to the
  // panel, so act() shows the same Chinese reason a thrown manage action would.
  if (data.ok === false && typeof data.message === 'string') throw new Error(data.message)
  return data as Status
}
type Way = 'public' | 'lan'
export const WAYS: Array<{ mode: Way; name: string; text: string }> = [
  { mode: 'lan', name: '同一 Wi‑Fi', text: '同一网络直连，无需公网配置。' },
  { mode: 'public', name: '公网连接', text: '异地或移动网络，需固定域名。' },
]
const wayName = (mode: string | undefined) => WAYS.find(way => way.mode === mode)?.name ?? ''
function icon(): React.ReactNode { return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true }, h('rect', { x: 7, y: 2, width: 10, height: 20, rx: 3 }), h('path', { d: 'M10 5h4M11 19h2' })) }
function WayIcon({ mode }: { mode: Way }): React.ReactElement {
  return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    mode === 'lan'
      ? h(React.Fragment, null, h('path', { d: 'M3 9a14 14 0 0 1 18 0M6 13a9 9 0 0 1 12 0M9.5 16.5a4 4 0 0 1 5 0' }), h('circle', { cx: 12, cy: 20, r: .8, fill: 'currentColor', stroke: 0 }))
      : h(React.Fragment, null, h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M3 12h18M12 3c3 3.4 3 14.6 0 18M12 3c-3 3.4-3 14.6 0 18' })))
}
function UpdateIcon(): React.ReactElement {
  return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: 'M12 3v11m0 0 4-4m-4 4-4-4' }), h('path', { d: 'M4 16v2a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-2' }))
}
function moveRadio(event: React.KeyboardEvent<HTMLButtonElement>, index: number, count: number, choose: (index: number) => void): void {
  const offset = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0
  if (!offset && event.key !== 'Home' && event.key !== 'End') return
  event.preventDefault()
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : (index + offset + count) % count
  choose(next)
  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=radio]')[next]?.focus()
}
export const when = (time: number) => new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const address = (value: string) => {
  try { const url = new URL(value); return url.origin + (url.pathname === '/' ? '' : url.pathname) }
  catch { return value }
}
export type PublicNodeAddress = { ok: true; url: string } | { ok: false; error: string }
/** Mirrors the Host's rule so a malformed draft never reaches the manage API. */
export function parsePublicNodeAddress(value: string): PublicNodeAddress {
  const text = value.trim()
  if (!text) return { ok: false, error: '公网节点地址不能为空。' }
  let url: URL
  try { url = new URL(text) } catch { return { ok: false, error: '公网节点地址格式无效，请填写完整的 https:// 地址。' } }
  if (url.protocol !== 'https:') return { ok: false, error: '公网节点必须使用 https:// 地址。' }
  if (url.username || url.password) return { ok: false, error: '公网节点地址不能包含账号或密码。' }
  if (url.pathname !== '/' || url.search || url.hash) return { ok: false, error: '公网节点地址只能是域名，不能带路径、查询参数或锚点。' }
  return { ok: true, url: url.origin }
}
/** Host[:port] is the shortest unique label for buttons and confirmations. */
export function nodeHost(url: string): string {
  try { return new URL(url).host } catch { return url }
}
export function nodeKindLabel(kind: PublicNodeKind | null): string {
  return kind === 'gateway' ? '隧道网关' : kind === 'service' ? '自托管服务' : '待确认'
}
/** The Host shows fingerprints as eight upper-case groups of four digits. */
export function nodeFingerprintGroups(fingerprint: string | null): string {
  if (!fingerprint) return '尚未上报'
  const digits = fingerprint.replace(/[^0-9a-f]/gi, '').toUpperCase()
  if (digits.length !== 32) return fingerprint.toUpperCase()
  return digits.match(/.{4}/g)!.join('-')
}
export type NodeTone = 'ok' | 'warn' | 'danger' | 'neutral'
/** Protocol 2 names the node identity; protocol 1 only knows the flat host pair. */
export function publicNodeFingerprint(node: Pick<PublicNode, 'node' | 'fingerprint'>): string | null {
  return node.node?.fingerprint ?? node.fingerprint
}
/** The protocol tag tells a v2 node apart from a v1 single-host gateway without opening the row. */
export function publicNodeProtocolLabel(protocol: number | null): string {
  return protocol === 2 ? 'v2' : protocol === 1 ? '旧版 v1（单主机）' : '协议待确认'
}
export function nodeCheckStatus(node: Pick<PublicNode, 'pending' | 'lastCheckAt' | 'lastCheckOk'>): { label: string; tone: NodeTone } {
  if (node.pending) return { label: '待检测确认', tone: 'warn' }
  if (node.lastCheckAt === null) return { label: '尚未检测', tone: 'neutral' }
  return node.lastCheckOk ? { label: '检测正常', tone: 'ok' } : { label: '检测失败', tone: 'danger' }
}
/** Relative wording keeps the list scannable; old probes fall back to the panel's absolute form. */
export function checkedAtLabel(at: number | null, now = Date.now()): string {
  if (at === null) return '尚未检测'
  const elapsed = Math.max(0, now - at)
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} 天前`
  return when(at)
}
/** The current entry first, then entries awaiting confirmation, then the most recently probed. */
export function sortPublicNodes(nodes: readonly PublicNode[], current: string | null): PublicNode[] {
  const rank = (node: PublicNode) => node.id === current ? 0 : node.pending ? 1 : 2
  return [...nodes].sort((left, right) => rank(left) - rank(right)
    || (right.lastCheckAt ?? 0) - (left.lastCheckAt ?? 0)
    || right.addedAt - left.addedAt
    || left.url.localeCompare(right.url))
}
export function serviceStateLabel(service: Pick<ServiceNodeState, 'connected' | 'lastError'>): { label: string; tone: NodeTone; reason: string } {
  if (service.connected) return { label: '已连接', tone: 'ok', reason: '' }
  if (service.lastError) return { label: '未连接', tone: 'danger', reason: service.lastError }
  return { label: '正在连接…', tone: 'warn', reason: '' }
}
const AVATAR_TONES = ['indigo', 'teal', 'violet', 'warm'] as const
const avatarTone = (seed: string) => AVATAR_TONES[[...seed].reduce((sum, character) => sum + (character.codePointAt(0) ?? 0), 0) % AVATAR_TONES.length]!
function StrokeIcon({ children }: { children: React.ReactNode }): React.ReactElement {
  return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, children)
}
function DeviceIcon(): React.ReactElement {
  return h(StrokeIcon, null, h('rect', { x: 3, y: 4.5, width: 18, height: 12, rx: 2 }), h('path', { d: 'M1.5 19.5h21' }), h('path', { d: 'M9 8.5h6' }))
}
function BellIcon(): React.ReactElement {
  return h(StrokeIcon, null, h('path', { d: 'M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6' }), h('path', { d: 'M10.3 19.5a2 2 0 0 0 3.4 0' }))
}
function GearIcon(): React.ReactElement {
  return h(StrokeIcon, null, h('circle', { cx: 12, cy: 12, r: 3 }), h('path', { d: 'M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7' }))
}
function NodeIcon(): React.ReactElement {
  return h(StrokeIcon, null, h('rect', { x: 3.5, y: 4, width: 17, height: 6.5, rx: 2 }), h('rect', { x: 3.5, y: 13.5, width: 17, height: 6.5, rx: 2 }), h('path', { d: 'M7 7.2h.01M7 16.8h.01' }))
}
const cardIcon = (tone: 'indigo' | 'teal' | 'violet' | 'warm' | 'slate', icon: React.ReactElement): React.ReactElement =>
  block('span', 'dsrc-card-icon', [icon], { 'data-tone': tone })
const block = (tag: 'div' | 'section' | 'span', className: string, children: React.ReactNode[], props: Record<string, unknown> = {}): React.ReactElement => h(tag, { className, ...props }, ...children)
function StatusNote({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'ok' | 'danger' | 'warn' }): React.ReactElement {
  return block('div', 'dsrc-status-note', [h('span', { className: 'dsrc-status-label' }, label), h('span', { className: 'dsrc-status-value' }, value)], { 'data-tone': tone })
}
function InlineNotice({ tone = 'info', children, action }: { tone?: 'info' | 'warn' | 'danger'; children?: React.ReactNode; action?: { label: string; onClick: () => void } }): React.ReactElement {
  return block('div', 'dsrc-inline-notice', [block('div', 'dsrc-notice-copy', [children]),
    action ? h('button', { type: 'button', className: 'dsrc-button dsrc-notice-action', onClick: action.onClick }, action.label) : null], { 'data-tone': tone, role: tone === 'danger' ? 'alert' : 'status' })
}
function DeviceRow({ device, disabled, act }: { device: Status['devices'][number]; disabled: boolean; act: (action: string, fields?: Record<string, unknown>) => Promise<unknown> }): React.ReactElement {
  const [name, setName] = React.useState<string | null>(null)
  const finished = React.useRef(false)
  const finish = (save: boolean) => {
    if (finished.current) return
    finished.current = true
    const next = save ? name?.trim() : ''
    setName(null)
    if (next && next !== device.name) void act('rename', { id: device.id, name: next })
  }
  return block('div', 'dsrc-device dsrc-row', [
    block('span', 'dsrc-avatar', [(device.name.trim().charAt(0) || '·').toUpperCase()], { 'data-tone': avatarTone(device.id), 'aria-hidden': true }),
    block('div', 'dsrc-device-main', [
      name === null ? block('div', 'dsrc-device-name', [device.name,
        device.via ? h('span', { className: 'dsrc-tag', 'data-way': device.via }, wayName(device.via)) : null,
        device.requiresRepair ? h('span', { className: 'dsrc-tag dsrc-pending' }, '需重新配对') : null,
        device.online ? h('span', { className: 'dsrc-tag dsrc-online' }, '在线') : null])
        : h('input', { className: 'dsrc-rename', 'aria-label': `重命名 ${device.name}`, autoFocus: true, maxLength: 40, value: name, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value), onBlur: () => finish(true), onKeyDown: (event: React.KeyboardEvent) => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); finish(event.key === 'Enter') } } }),
      h('div', { className: 'dsrc-device-meta' }, `配对于 ${when(device.createdAt)} · 最近使用 ${when(device.lastSeenAt)}`)]),
    block('div', 'dsrc-actions', [
      h('button', { type: 'button', className: 'dsrc-button dsrc-ghost', disabled, onClick: () => { finished.current = false; setName(device.name) } }, '重命名'),
      h('button', { type: 'button', className: 'dsrc-button dsrc-danger', disabled, onClick: () => { if (confirm(`撤销“${device.name}”的授权？这台设备需要重新扫码配对。`)) void act('revoke', { id: device.id }) } }, '撤销授权')]),
  ])
}

/** The plugin manager arrives after the panel mounts (or never), so the prop is a live resolver. */
interface PanelProps { manager: () => PluginManagerFace | null }
export function RemoteControlPanel({ manager }: PanelProps): React.ReactElement {
  const [state, setState] = React.useState<Status | null>(null)
  const [error, setError] = React.useState('')
  const [statusError, setStatusError] = React.useState('')
  const [workingAction, setWorkingAction] = React.useState('')
  const [workingNode, setWorkingNode] = React.useState('')
  const [proxy, setProxy] = React.useState<string | null>(null)
  const [domain, setDomain] = React.useState<string | null>(null)
  const [nodeDraft, setNodeDraft] = React.useState('')
  const [nodeError, setNodeError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [copyFallback, setCopyFallback] = React.useState<string | null>(null)
  const [toast, setToast] = React.useState('')
  const toastTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const say = (text: string) => { setToast(text); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 2200) }
  React.useEffect(() => () => clearTimeout(toastTimer.current), [])
  const mounted = React.useRef(true), pending = React.useRef(false)
  const revision = React.useRef(0), acting = React.useRef(false)
  const refresh = React.useCallback(async () => {
    if (pending.current || acting.current || document.hidden) return
    pending.current = true
    const ticket = revision.current
    try {
      const data = await command({ action: 'status' })
      if (mounted.current && ticket === revision.current) { setState(data); setStatusError('') }
    } catch (failure) {
      if (mounted.current && ticket === revision.current) setStatusError(failure instanceof Error ? failure.message : '状态读取失败。')
    } finally { pending.current = false }
  }, [])
  React.useEffect(() => {
    mounted.current = true
    const update = () => { void refresh() }
    update()
    const timer = setInterval(update, 2000)
    document.addEventListener('visibilitychange', update)
    return () => { mounted.current = false; clearInterval(timer); document.removeEventListener('visibilitychange', update) }
  }, [refresh])
  const update = updateStoreFor(manager)
  const updateState = React.useSyncExternalStore(
    React.useCallback((notify: () => void) => update.subscribe(notify), [update]),
    () => update.snapshot(),
  )
  React.useEffect(() => {
    hostVersion = state?.version ?? null
    update.noteInstalled(hostVersion)
  }, [state?.version, update])
  // Opening the panel checks once; the store's ten-minute cache keeps polls and reopenings quiet.
  React.useEffect(() => { if (state?.local) void update.check() }, [state?.local, update])
  const act = async (action: string, fields: Record<string, unknown> = {}) => {
    if (acting.current) return false
    acting.current = true; revision.current++
    setWorkingAction(action); setWorkingNode(typeof fields.id === 'string' ? fields.id : ''); setNotice(''); setCopyFallback(null); setError('')
    try {
      const data = await command({ action, ...fields })
      if (data.links) setState(data)
      if (action === 'certificate') setNotice('证书申请或续期已开始，状态会自动更新。')
      else if (action === 'reloadLanCertificate') setNotice('局域网 HTTPS 证书已重载，新连接将使用更新后的证书。')
      else if (action === 'switch') setNotice('已提交切换，当前访问即将断开。请使用新入口重新连接。')
      else if (action === 'stop') {
        setState(previous => previous ? { ...previous, enabled: false, activeMode: undefined, phase: 'off', links: [], requests: [], qr: undefined } : previous)
        setNotice('远程连接已关闭，设备授权保留。')
      } else if (['preferences', 'rename'].includes(action)) {
        setNotice(action === 'preferences' ? '设置已保存。' : '设备名称已更新。')
        setTimeout(() => { void refresh() }, 200)
      } else if (['approve', 'reject', 'revoke', 'revokeAll'].includes(action)) setTimeout(() => { void refresh() }, 200)
      else if (action === 'addPublicNode') { setNotice('公网节点已添加并通过检测。'); setTimeout(() => { void refresh() }, 200) }
      else if (action === 'checkPublicNode') setTimeout(() => { void refresh() }, 200)
      else if (action === 'setCurrentPublicNode') setNotice('已切换当前使用的公网节点。')
      else if (action === 'confirmPublicNodeIdentity') { setNotice('节点身份已确认，正在重新检测。'); setTimeout(() => { void refresh() }, 200) }
      else if (action === 'removePublicNode') setNotice('公网节点已删除，通过它的设备授权已撤销。')
      else if (action === 'approveServicePairing') setNotice('设备已确认，可以通过该节点继续连接。')
      else if (action === 'rejectServicePairing') setNotice('已拒绝该设备的配对请求。')
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作失败。')
      // The Host records a failed probe too, so show the refreshed row even though the call failed.
      if (action === 'addPublicNode' || action === 'checkPublicNode') setTimeout(() => { void refresh() }, 200)
      return false
    } finally { acting.current = false; setWorkingAction(''); setWorkingNode('') }
  }
  const copy = async (url: string, message = '已复制配对链接') => {
    if (await copyText(url)) { setCopyFallback(null); setNotice(''); say(message); return }
    setCopyFallback(url)
    setNotice('浏览器不允许自动复制，请选中下方内容手动复制。')
  }
  const working = !!workingAction
  const disabled = working || !!state?.busy
  const expired = !!state?.expiresAt && Date.now() >= state.expiresAt
  const proxyMode = state?.proxyMode ?? 'off'
  const proxyDraft = proxy ?? state?.manualProxy ?? ''
  const proxyDirty = proxy !== null && proxyDraft.trim() !== (state?.manualProxy ?? '')
  let proxyInvalid = false
  if (proxyDraft.trim()) {
    try { const url = new URL(proxyDraft.trim()); proxyInvalid = !['http:', 'https:'].includes(url.protocol) || !!url.username || !!url.password }
    catch { proxyInvalid = true }
  }
  const publicUrl = state?.publicUrl ?? ''
  const domainDraft = domain ?? publicUrl
  const domainDirty = domain !== null && domainDraft.trim() !== publicUrl
  let domainInvalid = false
  if (domainDirty && domainDraft.trim()) {
    try { const url = new URL(domainDraft.trim()); domainInvalid = url.protocol !== 'https:' || url.pathname !== '/' || !!url.username || !!url.password || !!url.search || !!url.hash || !url.hostname.includes('.') }
    catch { domainInvalid = true }
  }
  const certificate = state?.certificate
  const certificateExpired = !!certificate?.expiresAt && certificate.expiresAt <= Date.now()
  const certificateLabel = state && !state.local ? '仅本机可管理' : !publicUrl ? '配置域名后可管理' : !certificate ? '正在读取证书状态' : certificate.pending ? '正在申请或续期' : certificateExpired ? '证书已过期' : certificate.selfSigned ? 'frpc 自签证书' : certificate.expiresAt ? `有效至 ${new Date(certificate.expiresAt).toLocaleDateString('zh-CN')}` : '尚未申请'
  const lanCertificate = state?.lanTls
  const lanCertificateExpired = !!lanCertificate?.expiresAt && lanCertificate.expiresAt <= Date.now()
  const lanCertificateDue = !!lanCertificate?.expiresAt && lanCertificate.expiresAt - Date.now() <= 30 * 24 * 3600_000
  // A renewed one-time pairing ticket does not invalidate already paired devices.
  const renewing = React.useRef(false)
  React.useEffect(() => {
    if (!state?.enabled || !expired || state.busy || acting.current || renewing.current || state.requests.length) return
    renewing.current = true
    const ticket = ++revision.current
    void command({ action: 'refresh' }).then(data => { if (mounted.current && ticket === revision.current) setState(data) }, () => {}).finally(() => { renewing.current = false })
  }, [state, expired, workingAction])
  const [asking, setAsking] = React.useState<Way | null>(null)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const domainInput = React.useRef<HTMLInputElement>(null)
  const openSettings = React.useCallback((focus = false) => {
    setSettingsOpen(true)
    if (focus) setTimeout(() => {
      domainInput.current?.focus({ preventScroll: true })
      domainInput.current?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    }, 60)
  }, [])
  const shown = state?.enabled ? state.activeMode : state?.mode
  const currentNode = state?.publicNodes?.list.find(entry => entry.id === state?.publicNodes?.current) ?? null
  const identityChangePending = currentNode?.identityChange ?? null
  const domainBlocked = shown === 'public' && !publicUrl
  React.useEffect(() => { if (domainBlocked) setSettingsOpen(true) }, [domainBlocked])
  const choose = (mode: Way) => {
    if (!state || disabled) return
    if (mode === 'public' && !publicUrl) {
      setAsking(null)
      setNotice(state.enabled ? '先保存固定公网域名，再切换到“公网连接”。' : '选择已保留。请填写固定公网域名，然后开启连接。')
      if (!state.enabled) void act('preferences', { mode })
      openSettings(true)
      return
    }
    if (!state.enabled) { void act('preferences', { mode }); return }
    setAsking(mode === state.activeMode ? null : mode)
  }
  const change = async (mode: Way) => {
    setAsking(null)
    if (mode === 'public' && !publicUrl) { openSettings(true); return }
    if (await act('preferences', { mode })) await act('switch')
  }
  const start = () => {
    if (domainBlocked || domainDirty || domainInvalid) {
      setNotice(domainBlocked ? '请先填写并保存固定公网域名。' : '请先保存固定公网域名。')
      openSettings(true)
      return
    }
    void act('start')
  }
  const firstURL = state?.links[0]?.url
  const online = state?.devices.filter(device => device.online).length ?? 0
  const connectionState = !state ? 'loading' : state.error ? 'error' : state.busy || working ? 'busy' : state.enabled ? 'ready' : domainBlocked ? 'blocked' : 'off'
  const connectionLabel = !state ? statusError ? '读取失败' : '正在读取' : state.error ? '连接失败' : state.busy || working ? '正在处理' : state.enabled ? online ? '设备已连接' : '等待手机扫码' : domainBlocked ? '需要配置域名' : '未开启'
  const settingsIssue = domainBlocked ? '需配置公网域名' : shown === 'public' && (certificate?.error || certificateExpired) ? '证书需处理' : shown === 'public' && state?.publicUrlCheck && !state.publicUrlCheck.reachable ? '公网检测未通过' : ''
  const button = (label: string, action: string, fields?: Record<string, unknown>, extra = '') => h('button', { type: 'button', className: `dsrc-button ${extra}`, disabled, onClick: () => { void act(action, fields) } }, label)
  /** A new ticket drops every request waiting for approval, so refresh waits for them. */
  const refreshCode = () => {
    if (state?.requests.length) { setNotice('还有配对请求在等待确认，请先处理后再刷新二维码。'); return }
    void act('refresh').then(saved => { if (saved) say('二维码已刷新') })
  }
  /** A phone that closes the gateway has no way back; the computer can always open it again. */
  const stopConnection = () => {
    if (!state) return
    if (!state.local && !confirm('关闭远程连接会立即断开这台手机，并且只能在电脑上重新开启。继续？')) return
    void act('stop')
  }

  /** Public entries recorded for this Host: probe, confirm, choose or delete them without leaving the panel. */
  const nodes = () => {
    if (!state || shown !== 'public' || !state.publicNodes) return null
    const entries = state.publicNodes
    const list = sortPublicNodes(entries.list, entries.current)
    const service = state.serviceNode
    const serviceState = service ? serviceStateLabel(service) : null
    // Only the Host itself may change the list; a panel opened through an entry gets a read-only view.
    const manageDisabled = disabled || !state.local
    const submitNode = (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const parsed = parsePublicNodeAddress(nodeDraft)
      if (!parsed.ok) { setNodeError(parsed.error); return }
      setNodeError('')
      void act('addPublicNode', { url: parsed.url }).then(saved => { if (saved) setNodeDraft('') })
    }
    const nodeRow = (node: PublicNode) => {
      const current = node.id === entries.current
      const check = nodeCheckStatus(node)
      const host = nodeHost(node.url)
      const busy = workingNode === node.id
      const change = node.identityChange
      return block('div', 'dsrc-node dsrc-row', [
        block('div', 'dsrc-node-main', [
          block('div', 'dsrc-node-title', [
            h('span', { className: 'dsrc-node-name' }, node.name?.trim() || host),
            h('span', { className: 'dsrc-tag dsrc-node-kind', 'data-kind': node.kind ?? 'unknown' }, nodeKindLabel(node.kind)),
            h('span', { className: 'dsrc-tag dsrc-node-protocol', 'data-protocol': node.protocol === 2 ? 'v2' : node.protocol === 1 ? 'v1' : 'unknown' }, publicNodeProtocolLabel(node.protocol)),
            current ? h('span', { className: 'dsrc-tag dsrc-online' }, '当前使用') : null,
            node.pending ? h('span', { className: 'dsrc-tag dsrc-pending' }, '待确认') : null,
            change ? h('span', { className: 'dsrc-tag dsrc-pending' }, '身份待确认') : null,
          ]),
          h('code', { className: 'dsrc-node-url', title: node.url }, address(node.url)),
          block('div', 'dsrc-node-meta', [
            h('span', { className: 'dsrc-node-check', role: 'status', 'data-tone': check.tone }, check.label),
            h('span', null, `最近检测 ${checkedAtLabel(node.lastCheckAt)}`),
            // A v2 node names its own identity; a v1 record is a single-host gateway and keeps the old label.
            node.protocol === 2
              ? h('span', { className: 'dsrc-node-fingerprint' }, `节点指纹 ${nodeFingerprintGroups(publicNodeFingerprint(node))}`)
              : node.protocol === 1
                ? h('span', { className: 'dsrc-node-fingerprint' }, `Host 指纹 ${nodeFingerprintGroups(node.fingerprint)}`)
                : null,
          ]),
          !node.pending && !node.lastCheckOk && node.lastCheckError ? h('p', { className: 'dsrc-node-error', role: 'alert' }, node.lastCheckError) : null,
          change ? block('div', 'dsrc-node-identity', [
            h('p', { className: 'dsrc-node-error', role: 'alert' }, '节点身份已变化，需要重新确认。'),
            h('p', { className: 'dsrc-node-fingerprints' }, `原节点指纹 ${nodeFingerprintGroups(change.from.fingerprint)}`),
            h('p', { className: 'dsrc-node-fingerprints' }, `新节点指纹 ${nodeFingerprintGroups(change.to.fingerprint)}`),
            h('button', {
              type: 'button', className: 'dsrc-button dsrc-primary', disabled: manageDisabled, 'aria-label': `重新确认节点 ${host} 的身份`,
              onClick: () => { if (confirm(`确认 ${host} 的新节点指纹？确认前不会通过该节点连接。`)) void act('confirmPublicNodeIdentity', { id: node.id }) },
            }, busy ? '正在确认…' : '重新确认'),
          ]) : null,
        ]),
        node.pending
          ? block('div', 'dsrc-actions dsrc-node-actions', [
              h('button', { type: 'button', className: 'dsrc-button dsrc-primary', disabled: manageDisabled || !!change, 'aria-label': `确认使用节点 ${host}`, onClick: () => { void act('setCurrentPublicNode', { id: node.id }) } }, busy ? '正在确认…' : '确认使用'),
              h('button', { type: 'button', className: 'dsrc-button dsrc-ghost', disabled: manageDisabled, 'aria-label': `忽略节点 ${host}`, onClick: () => { void act('removePublicNode', { id: node.id }) } }, busy ? '正在忽略…' : '忽略'),
            ])
          : block('div', 'dsrc-actions dsrc-node-actions', [
              h('button', { type: 'button', className: 'dsrc-button dsrc-ghost', disabled: manageDisabled, 'aria-label': `检测节点 ${host}`, onClick: () => { void act('checkPublicNode', { id: node.id }) } }, busy ? '正在检测…' : '检测'),
              h('button', { type: 'button', className: 'dsrc-button', disabled: manageDisabled || current || !!change, 'aria-label': `将节点 ${host} 设为当前`, onClick: () => { void act('setCurrentPublicNode', { id: node.id }) } }, current ? '当前使用' : change ? '需先确认身份' : busy ? '正在切换…' : '设为当前'),
              h('button', { type: 'button', className: 'dsrc-button dsrc-danger', disabled: manageDisabled, 'aria-label': `删除节点 ${host}`, onClick: () => { if (confirm(`删除公网节点 ${address(node.url)}？通过该节点授权的设备会被撤销。`)) void act('removePublicNode', { id: node.id }) } }, busy ? '正在删除…' : '删除'),
            ]),
      ], { key: node.id, role: 'listitem' })
    }
    return block('section', 'dsrc-nodes', [
      block('div', 'dsrc-card-head', [
        cardIcon('teal', h(NodeIcon, null)),
        h('h3', null, '公网节点'),
        list.length ? h('span', { className: 'dsrc-count' }, String(list.length)) : null,
      ]),
      service && serviceState ? block('div', 'dsrc-service-state', [
        h('span', { className: 'dsrc-service-dot', 'aria-hidden': true }),
        h('span', null, '自托管节点'),
        h('strong', { role: 'status' }, serviceState.label),
        serviceState.reason ? h('span', { className: 'dsrc-service-reason' }, `原因：${serviceState.reason}`) : null,
        h('span', { className: 'dsrc-service-origin', title: service.origin }, address(service.origin)),
      ], { 'data-tone': serviceState.tone }) : null,
      entries.pendingReview ? h(InlineNotice, { tone: 'warn' }, '检测到旧公网地址，确认后才会使用。') : null,
      list.length
        ? h('div', { className: 'dsrc-node-list', role: 'list', 'aria-label': '公网节点' }, list.map(nodeRow))
        : h('p', { className: 'dsrc-empty' }, '还没有公网节点。填写 https 地址后先检测，确认指纹再使用。'),
      block('div', 'dsrc-node-add', [
        h('label', { className: 'dsrc-field-label', htmlFor: 'dsrc-node-url' }, '添加节点'),
        // noValidate keeps the browser bubble out of the way: the Host-style wording above is the only feedback.
        h('form', { className: 'dsrc-input', noValidate: true, onSubmit: submitNode }, [
          h('input', {
            id: 'dsrc-node-url', type: 'url', value: nodeDraft, placeholder: 'https://node.example.com', spellCheck: false, autoComplete: 'off',
            disabled: manageDisabled, 'aria-invalid': !!nodeError, 'aria-label': '公网节点 HTTPS 地址',
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setNodeDraft(event.target.value); if (nodeError) setNodeError('') },
          }),
          h('button', { type: 'submit', className: 'dsrc-button dsrc-primary', disabled: manageDisabled || !nodeDraft.trim() }, workingAction === 'addPublicNode' ? '正在添加…' : '添加'),
        ]),
        nodeError ? h('p', { className: 'dsrc-error', role: 'alert' }, nodeError) : null,
        h('p', { className: 'dsrc-note' }, state.local
          ? '只填写 https:// 域名（可带端口），不能包含路径、查询参数或账号密码。'
          : '公网节点只能在本机面板添加、检测或切换。'),
        h('p', { className: 'dsrc-note dsrc-node-trust' }, '通过 HTTPS 连接该节点。节点或隧道运营者可能看到转发给本机的请求与内容，本插件不提供端到端加密。请只添加你信任的节点。'),
      ]),
    ], { 'aria-label': '公网节点', 'data-section': 'nodes' })
  }

  const main = () => {
    if (!state) return block('section', 'dsrc-surface dsrc-loading', [
      h('span', { className: 'dsrc-loading-mark', 'aria-hidden': true }),
      block('div', '', [h('h3', null, statusError ? '暂时无法读取状态' : '正在读取远程连接'), h('p', { className: 'dsrc-note' }, statusError || '正在获取连接方式、二维码与授权设备…')]),
      statusError ? h('button', { type: 'button', className: 'dsrc-button', onClick: () => { void refresh() } }, '重试') : null,
    ], { 'aria-busy': !statusError, role: 'status' })
    const modeButtons = block('div', 'dsrc-ways', WAYS.map((way, index) => h('button', {
      key: way.mode, type: 'button', role: 'radio', 'data-mode': way.mode, className: 'dsrc-way', 'aria-checked': shown === way.mode, title: way.text,
      tabIndex: shown === way.mode || !shown && index === 0 ? 0 : -1, disabled, onClick: () => choose(way.mode),
      onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => moveRadio(event, index, WAYS.length, next => choose(WAYS[next]!.mode)),
    }, h('span', { className: 'dsrc-way-icon' }, h(WayIcon, { mode: way.mode })),
    block('span', 'dsrc-way-copy', [block('span', 'dsrc-way-name', [way.name, state.enabled && state.activeMode === way.mode ? h('span', { className: 'dsrc-tag dsrc-online' }, '使用中') : null])]))), { role: 'radiogroup', 'aria-label': '连接方式' })
    const code = block('div', 'dsrc-scan', [
      state.qr && !expired ? block('div', 'dsrc-code', [h('img', { src: state.qr, alt: `${wayName(shown)}远程控制配对二维码`, draggable: false })], { 'data-ready': true })
        : block('div', 'dsrc-code', [block('div', 'dsrc-placeholder', [expired ? '正在更新二维码…' : state.busy ? '连接就绪后显示二维码' : domainBlocked ? '配置域名并开启后显示二维码' : '开启连接后显示配对二维码'])]),
      state.qr && !expired ? h('button', { type: 'button', className: 'dsrc-button dsrc-ghost dsrc-code-refresh', disabled, onClick: refreshCode }, workingAction === 'refresh' ? '正在刷新…' : '刷新二维码') : null,
      shown === 'public' && state.local && state.publicUrlCheck && !state.publicUrlCheck.reachable ? h('p', { className: 'dsrc-error', role: 'alert' }, state.publicUrlCheck.error ?? '公网节点不可达，请确认隧道客户端正在运行，或检查域名配置。') : null,
      block('div', 'dsrc-steps', ['手机相机扫码', shown === 'public' ? state.node.kind === 'gateway' ? '核对指纹，本机确认' : '核对节点，本机确认' : '在本机确认配对', '继续会话与审批'].map((step, index) => block('span', 'dsrc-step', [h('span', { className: 'dsrc-number' }, String(index + 1)), h('span', null, step)], { key: step }))),
    ])
    const brief = block('div', 'dsrc-brief', [
      block('div', 'dsrc-connection-state', [
        h('strong', null, state.busy ? '正在启动连接…' : state.enabled ? online ? '手机已连接，可以继续使用' : '连接已就绪，等待手机扫码' : domainBlocked ? '还差一个固定公网域名' : '开启后，用手机继续操作'),
        h('p', null, state.enabled ? online ? `${online} 台设备在线；也可以继续配对其他手机。` : '已授权设备可直接使用，新手机请扫码。' : domainBlocked ? '域名通常只需配置一次，保存后回到这里开启。' : shown === 'public' ? `将通过 ${address(publicUrl)} 连接。` : '同一 Wi‑Fi 即可直连，授权设备可重复使用。'),
      ]),
      domainBlocked ? h(InlineNotice, { tone: 'warn', action: { label: '配置域名', onClick: () => openSettings(true) } }, '“公网连接”需要固定公网域名，请在“连接设置”里填写。') : null,
      identityChangePending && currentNode ? block('div', 'dsrc-pane-message', [h(InlineNotice, { tone: 'danger' }, `当前公网节点「${currentNode.name?.trim() || nodeHost(currentNode.url)}」的身份已变化，请在下方“公网节点”中重新确认；确认前不会通过该节点连接。`)]) : null,
      shown === 'lan' && lanCertificate ? h(InlineNotice, { tone: lanCertificate.error || lanCertificateDue ? 'warn' : 'info' },
        lanCertificate.error || (lanCertificateDue ? '局域网证书即将到期，请在外部续期后，在本机连接设置中重载。' : '使用局域网 HTTPS。请将域名解析到电脑的局域网地址，并使用手机信任的证书。')) : null,
      state.error && !identityChangePending ? block('div', 'dsrc-pane-message', [h(InlineNotice, { tone: 'danger' }, state.error)]) : null,
      state.pairingFailure ? block('div', 'dsrc-pane-message', [h(InlineNotice, { tone: 'danger' }, `配对被拒绝${state.pairingFailure.name ? `（${state.pairingFailure.name}）` : ''}：${state.pairingFailure.reason}`)]) : null,
      shown === 'public' && state.publicUrlCheck && !state.publicUrlCheck.reachable ? block('div', 'dsrc-pane-message', [h(InlineNotice, { tone: 'warn', action: { label: '检查设置', onClick: () => openSettings() } }, state.publicUrlCheck.error ?? '公网节点不可达，请确认隧道客户端正在运行，或检查域名配置。')]) : null,
      block('div', 'dsrc-connection-actions', [state.enabled ? h('button', { type: 'button', className: 'dsrc-button dsrc-stop', disabled, onClick: stopConnection }, workingAction === 'stop' ? '正在关闭…' : '关闭远程连接')
        : h('button', { type: 'button', className: 'dsrc-button dsrc-primary dsrc-start', disabled, onClick: start }, state.busy || workingAction === 'start' ? '正在开启…' : domainBlocked ? '先配置域名' : '开启远程连接')]),
      h('label', { className: 'dsrc-toggle' }, h('input', { type: 'checkbox', checked: state.autoStart, disabled, onChange: (event: React.ChangeEvent<HTMLInputElement>) => { void act('preferences', { autoStart: event.target.checked }) } }), '随 DSH 自动开启'),
      firstURL && !expired ? block('div', 'dsrc-pair-link', [
        h('code', { className: 'dsrc-link', title: address(firstURL) }, address(firstURL)),
        h('button', { type: 'button', className: 'dsrc-button', onClick: () => { void copy(firstURL) } }, '复制链接'),
      ]) : null,
      state.links.length > 1 ? h('details', { className: 'dsrc-networks' }, h('summary', null, `其他网卡（${state.links.length - 1}）`),
        block('div', 'dsrc-alt-links', state.links.slice(1).map(link => h('button', { key: link.base, type: 'button', className: 'dsrc-button dsrc-address-button', title: '复制此网卡的完整配对链接', disabled: !link.url, onClick: () => { if (link.url) void copy(link.url) } }, address(link.base))))) : null,
    ])
    return block('section', 'dsrc-surface dsrc-workspace', [
      modeButtons,
      asking ? block('div', 'dsrc-confirm', [
        h('p', null, `切换到“${wayName(asking)}”？已连接的手机会断开，需要重新配对。`),
        block('div', 'dsrc-actions', [h('button', { type: 'button', className: 'dsrc-button', disabled, onClick: () => setAsking(null) }, '取消'),
          h('button', { type: 'button', className: 'dsrc-button dsrc-primary', disabled, onClick: () => { void change(asking) } }, '切换连接')]),
      ], { role: 'alertdialog', 'aria-label': '更换连接方式' }) : null,
      block('div', 'dsrc-stage', [code, brief]),
      nodes(),
      statusError ? block('div', 'dsrc-panel-message', [h('span', null, `状态更新失败，当前显示上次结果。${statusError}`), h('button', { type: 'button', className: 'dsrc-button', onClick: () => { void refresh() } }, '重试')], { 'data-tone': 'warn', role: 'alert' }) : null,
      error && error !== state.error ? block('div', 'dsrc-panel-message', [error], { 'data-tone': 'danger', role: 'alert' }) : null,
      notice ? block('div', 'dsrc-panel-message', [notice, copyFallback !== null ? h('textarea', { className: 'dsrc-copy-fallback', readOnly: true, 'aria-label': '待复制内容，可全选复制', value: copyFallback, onFocus: (event: React.FocusEvent<HTMLTextAreaElement>) => event.currentTarget.select() }) : null], { 'data-tone': 'info', role: 'status' }) : null,
    ], { 'data-section': 'connection', 'data-state': connectionState })
  }

  /** Update card: the panel only ever asks the DSH plugin manager, never a registry or a shell. */
  const updateSection = () => {
    if (!state?.local) return null
    const card = updateCard(updateState)
    const working = updateState.busy
    const actOnCard = () => {
      if (updateState.confirm) void update.update()
      else if (updateState.phase === 'available') update.ask()
      else void update.check(true)
    }
    return block('section', 'dsrc-surface dsrc-update', [
      block('div', 'dsrc-card-head', [
        cardIcon('slate', h(UpdateIcon, null)),
        h('h3', null, '插件更新'),
        h('span', { className: 'dsrc-tag', 'data-tone': card.tone, 'aria-label': `当前版本 ${card.version}` }, `v${card.version}`),
      ]),
      h('p', { className: 'dsrc-update-status', 'data-tone': card.tone, role: 'status' }, working && !card.action ? '正在处理，请不要关闭 DSH…' : card.status),
      card.detail ? h('p', { className: 'dsrc-muted' }, card.detail) : null,
      block('div', 'dsrc-actions dsrc-update-actions', [
        updateState.confirm ? h('button', { type: 'button', className: 'dsrc-button', disabled: working, onClick: () => update.cancel() }, '取消') : null,
        card.action ? h('button', { type: 'button', className: `dsrc-button${updateState.confirm ? ' dsrc-primary' : ''}`, disabled: working, onClick: actOnCard }, working ? '正在更新…' : card.action) : null,
      ]),
    ], { 'data-section': 'plugin-update', 'data-phase': updateState.phase })
  }

  const settings = () => {
    if (!state) return null
    const lanSettings = lanCertificate ? block('section', 'dsrc-setting-group', [
      block('div', 'dsrc-setting-heading', [h('h3', null, '局域网 HTTPS'), h('span', { className: 'dsrc-setting-kicker' }, '固定域名与外部证书')]),
      h(StatusNote, { label: '入口', value: lanCertificate.origin ?? '开启连接并验证证书后显示' }),
      block('div', 'dsrc-setting-row', [
        h(StatusNote, { label: '证书', value: lanCertificateExpired ? '证书已过期' : lanCertificate.expiresAt ? `有效至 ${new Date(lanCertificate.expiresAt).toLocaleDateString('zh-CN')}` : '尚未读取', tone: lanCertificateExpired ? 'danger' : lanCertificateDue ? 'warn' : lanCertificate.expiresAt ? 'ok' : 'neutral' }),
        h('button', { type: 'button', className: 'dsrc-button', disabled: disabled || !state.local || !state.enabled || state.activeMode !== 'lan', onClick: () => { void act('reloadLanCertificate') } }, workingAction === 'reloadLanCertificate' ? '正在重载…' : '重载证书'),
      ]),
      lanCertificate.error ? h('p', { className: 'dsrc-error', role: 'alert' }, lanCertificate.error) : null,
      h('p', { className: 'dsrc-note' }, '证书由外部签发和续期；更新文件后在本机重载。域名、证书路径和固定端口在插件配置中设置。'),
      h('p', { className: 'dsrc-note' }, state.lanHint),
    ], { 'aria-label': '局域网 HTTPS' }) : null
    const publicSettings = block('section', 'dsrc-setting-group', [
      block('div', 'dsrc-setting-heading', [h('h3', null, '公网连接'), h('span', { className: 'dsrc-setting-kicker' }, '固定域名与证书')]),
      block('div', 'dsrc-field dsrc-domain-field', [
        h('label', { htmlFor: 'dsrc-public-url' }, '固定公网域名'),
        block('div', 'dsrc-input', [
          h('input', { id: 'dsrc-public-url', ref: domainInput, type: 'url', value: domainDraft, placeholder: 'https://dsh.example.com', spellCheck: false, autoComplete: 'off', disabled: disabled || !state.local || state.activeMode === 'public', 'aria-invalid': domainInvalid, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDomain(event.target.value) }),
          h('button', { type: 'button', className: 'dsrc-button', disabled: disabled || !state.local || !domainDirty || domainInvalid || state.activeMode === 'public', onClick: () => { void act('preferences', { publicUrl: domainDraft.trim() }).then(saved => { if (saved) setDomain(null) }) } }, '保存'),
        ]),
        domainInvalid ? h('p', { className: 'dsrc-error' }, '请输入不带路径、账号或密码的 https:// 域名。') : null,
        h('p', { className: 'dsrc-note' }, !state.local ? '域名只能在连接到此电脑的本机面板修改。' : state.activeMode === 'public' ? '如需修改域名，请先关闭远程连接。' : `将 frpc 的 80 / 443 转发到本机端口 ${state.publicPort}。`),
      ]),
      block('div', 'dsrc-setting-row', [
        h(StatusNote, { label: '本机身份', value: `${state.node.name} · ${state.node.kind === 'gateway' ? '隧道网关' : '自托管服务'}` }),
        h(StatusNote, { label: '主机指纹', value: state.node.fingerprintGroups }),
      ]),
      h('p', { className: 'dsrc-note' }, '手机首次从公网配对时，页面先显示本机身份与主机指纹；在本机面板确认同一设备名与指纹后，才会下发设备授权。'),
      block('div', 'dsrc-setting-row', [
        h('button', { type: 'button', className: 'dsrc-button', disabled: disabled || !state.local || !publicUrl || domainDirty, onClick: () => { void act('checkPublicUrl') } }, workingAction === 'checkPublicUrl' ? '正在检测…' : state.publicUrlCheck ? '重新检测' : '检测连通性'),
        h(StatusNote, { label: '域名', value: state.publicUrlCheck ? state.publicUrlCheck.reachable ? `可访问${state.publicUrlCheck.status ? ` · HTTP ${state.publicUrlCheck.status}` : ''}` : `无法访问${state.publicUrlCheck.error ? ` · ${state.publicUrlCheck.error}` : ''}` : state.local ? '尚未检测' : '仅本机可检测', tone: state.publicUrlCheck ? state.publicUrlCheck.reachable ? 'ok' : 'danger' : 'neutral' }),
      ]),
      block('div', 'dsrc-field dsrc-certificate', [
        block('div', 'dsrc-setting-row', [
          h(StatusNote, { label: 'HTTPS 证书', value: certificateLabel, tone: certificateExpired || certificate?.error ? 'danger' : certificate?.pending ? 'warn' : certificate?.expiresAt && !certificate.selfSigned ? 'ok' : 'neutral' }),
          h('button', { type: 'button', className: 'dsrc-button', disabled: disabled || !state.local || !publicUrl || !!certificate?.pending || !state.enabled || state.activeMode !== 'public', title: !state.enabled || state.activeMode !== 'public' ? '开启公网连接后可申请证书' : undefined, onClick: () => { void act('certificate') } }, certificate?.pending || workingAction === 'certificate' ? '处理中…' : certificate?.expiresAt && !certificateExpired && !certificate.selfSigned ? '续期证书' : '申请证书'),
        ]),
        certificate?.restartRequired ? h('p', { className: 'dsrc-note' }, '证书已部署，请在 SakuraFrp 中重载对应隧道。') : null,
        certificate?.error ? h('p', { className: 'dsrc-error' }, '证书错误：' + certificate.error) : null,
      ]),
    ], { 'aria-label': '公网连接' })
    const network = block('section', 'dsrc-setting-group', [
      block('div', 'dsrc-setting-heading', [h('h3', null, '电脑网络代理'), h('span', { className: 'dsrc-setting-kicker' }, proxyMode === 'system' ? '自动检测' : proxyMode === 'manual' ? '手动设置' : '不使用')]),
      block('div', 'dsrc-mode', ([['off', '不使用'], ['system', '自动检测'], ['manual', '手动设置']] as const).map(([id, name]) => h('button', { key: id, type: 'button', 'aria-pressed': proxyMode === id, disabled: disabled || !state.local, onClick: () => { void act('preferences', { proxyMode: id }) } }, name)), { role: 'group', 'aria-label': '代理方式' }),
      proxyMode === 'system' ? h('p', { className: 'dsrc-note' }, state.systemProxy ? `已检测：${state.systemProxy.url} · ${state.systemProxy.source}` : '未检测到系统代理，将直接连接。') : null,
      proxyMode === 'manual' ? block('div', 'dsrc-field dsrc-proxy-field', [
        block('div', 'dsrc-input', [
          h('input', { 'aria-label': '电脑端代理地址', placeholder: 'http://127.0.0.1:7890', value: proxyDraft, 'aria-invalid': proxyInvalid, disabled: disabled || !state.local, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setProxy(event.target.value) }),
          h('button', { type: 'button', className: 'dsrc-button', disabled: disabled || !state.local || !proxyDirty || proxyInvalid, onClick: () => { void act('preferences', { proxy: proxyDraft.trim() }).then(saved => { if (saved) setProxy(null) }) } }, '保存'),
        ]),
        proxyInvalid ? h('p', { className: 'dsrc-error' }, '代理需为不带用户名和密码的 HTTP(S) 地址。') : null,
        !proxyDraft.trim() ? h('p', { className: 'dsrc-note' }, '留空并保存可移除手动代理。') : null,
      ]) : null,
      h('p', { className: 'dsrc-note' }, '仅用于电脑的域名检测和证书请求，不改变手机连接。'),
      block('div', 'dsrc-field dsrc-browser-entry', [
        h('span', { className: 'dsrc-field-label' }, '手机入口'),
        state.links[0]?.base
          ? h('a', { className: 'dsrc-button', href: state.links[0].base, target: '_blank', rel: 'noreferrer' }, '在浏览器打开')
          : h('p', { className: 'dsrc-note' }, '开启远程连接后，这里会给出手机要打开的地址。'),
        h('p', { className: 'dsrc-note' }, '手机使用电脑当前版本的 DSH 界面，界面随宿主更新。'),
      ]),
    ], { 'aria-label': '电脑网络代理与手机入口' })
    return h('details', { className: 'dsrc-surface dsrc-preferences', 'data-needed': !!settingsIssue, open: settingsOpen, onToggle: (event: React.SyntheticEvent<HTMLDetailsElement>) => setSettingsOpen(event.currentTarget.open) },
      h('summary', null,
        block('span', 'dsrc-settings-title', [cardIcon('slate', h(GearIcon, null)), '连接设置']),
        h('span', { className: `dsrc-summary-value${settingsIssue ? ' dsrc-needs-attention' : ''}` }, settingsIssue || `${publicUrl ? '域名已配置' : '域名未配置'}`)),
      block('div', 'dsrc-preferences-body', [lanSettings, publicSettings, network]))
  }
  const requests = () => state?.local && state.requests.length ? block('section', 'dsrc-surface dsrc-requests', [
    block('div', 'dsrc-card-head', [
      cardIcon('warm', h(BellIcon, null)),
      h('h3', null, '待确认配对'),
      h('span', { className: 'dsrc-tag dsrc-pending' }, `${state.requests.length} 项`),
    ]),
    h('p', { className: 'dsrc-note' }, '手机正在等待本机确认。请核对设备名与主机指纹；两项都一致再允许连接。'),
    ...state.requests.map(request => block('div', 'dsrc-device dsrc-row', [
      block('div', 'dsrc-device-main', [block('div', 'dsrc-device-name', [request.name,
        h('span', { className: 'dsrc-tag', 'data-way': request.via }, wayName(request.via)),
        request.via === 'public' ? h('span', { className: 'dsrc-tag' }, request.nodeConfirmed ? '手机已确认本机' : '手机未确认') : null]),
        h('div', { className: 'dsrc-muted' }, request.via === 'public' ? `主机指纹 ${state.node.fingerprintGroups}` : '局域网配对请求')]),
      block('div', 'dsrc-actions', [button('拒绝', 'reject', { id: request.id }), button('允许连接', 'approve', { id: request.id, name: request.name, fingerprint: state.node.fingerprint }, 'dsrc-primary')]),
    ], { key: request.id })),
  ], { 'data-section': 'requests' }) : null
  const devices = () => state ? block('section', 'dsrc-surface dsrc-devices', [
    block('div', 'dsrc-card-head', [
      cardIcon('violet', h(DeviceIcon, null)),
      h('h3', null, '已授权设备'),
      state.devices.length ? h('span', { className: 'dsrc-count' }, String(state.devices.length)) : null,
      h('span', { className: 'dsrc-spacer', 'aria-hidden': true }),
      state.devices.length ? h('button', { type: 'button', className: 'dsrc-button dsrc-danger', disabled, onClick: () => { if (confirm(`确定撤销全部 ${state.devices.length} 台设备的授权？所有已授权手机都需要重新配对。`)) void act('revokeAll') } }, '撤销全部') : null,
    ]),
    state.devices.length ? block('div', 'dsrc-device-list', state.devices.map(device => h(DeviceRow, { key: device.id, device, disabled, act }))) : h('p', { className: 'dsrc-empty' }, '暂无设备，扫码确认后会显示在这里。'),
    state.repairRequired ? h(InlineNotice, { tone: 'warn' }, `有 ${state.repairRequired} 台设备是通过旧公网入口授权的，升级后已标记为需要重新配对；旧授权不再放行。`) : null,
    h('p', { className: 'dsrc-note' }, '不同连接方式分别记录授权；连续 30 天未使用的授权会过期。'),
  ], { 'data-section': 'devices' }) : null
  /** Devices waiting on this Host to confirm a pairing with the self-hosted public node. */
  const servicePairings = () => {
    const pairings = state?.serviceNode?.pendingPairings ?? []
    if (!state?.local || !pairings.length) return null
    return block('section', 'dsrc-surface dsrc-requests', [
      block('div', 'dsrc-card-head', [
        cardIcon('warm', h(BellIcon, null)),
        h('h3', null, '待确认配对'),
        h('span', { className: 'dsrc-tag dsrc-pending' }, `${pairings.length} 项`),
      ]),
      h('p', { className: 'dsrc-note' }, '手机正在等待本机确认。确认后，该设备可以通过自托管公网节点继续连接。'),
      ...pairings.map(pairing => block('div', 'dsrc-device dsrc-row', [
        block('div', 'dsrc-device-main', [
          block('div', 'dsrc-device-name', [pairing.deviceName]),
          h('div', { className: 'dsrc-muted' }, `过期时间 ${when(pairing.expiresAt)}`),
        ]),
        block('div', 'dsrc-actions', [
          h('button', { type: 'button', className: 'dsrc-button', disabled, 'aria-label': `拒绝设备 ${pairing.deviceName}`, onClick: () => { void act('rejectServicePairing', { id: pairing.requestId }) } }, workingNode === pairing.requestId ? '正在拒绝…' : '拒绝'),
          h('button', { type: 'button', className: 'dsrc-button dsrc-primary', disabled, 'aria-label': `确认设备 ${pairing.deviceName}`, onClick: () => { void act('approveServicePairing', { id: pairing.requestId }) } }, workingNode === pairing.requestId ? '正在确认…' : '确认'),
        ]),
      ], { key: pairing.requestId })),
    ], { 'data-section': 'service-pairings' })
  }
  return block('div', 'dsrc', [
    h('header', { className: 'dsrc-head' }, block('div', '', [h('h2', null, '远程控制'), h('p', { className: 'dsrc-sub' }, '用手机浏览器继续电脑上的会话与审批。')]),
      h('span', { className: 'dsrc-badge', 'data-state': connectionState, role: 'status' }, h('span', { className: 'dsrc-dot' }), connectionLabel)),
    block('div', 'dsrc-layout', [
      block('div', 'dsrc-col dsrc-col-main', [main(), updateSection()]),
      block('div', 'dsrc-col dsrc-col-rail', [requests(), servicePairings(), devices(), settings()]),
    ]),
    toast ? block('div', 'dsrc-toast', [h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'm5 12 5 5 9-10' })), toast], { role: 'status', 'aria-live': 'polite' }) : null,
  ], { 'data-dsh-plugin': 'dsh-remote-connect' })
}
interface Waiting { enabled: boolean; node: { name: string; fingerprint: string; fingerprintGroups: string }; requests: Array<{ id: string; name: string; via: 'lan' | 'public'; nodeConfirmed: boolean; expiresAt: number }> }

/** Pairing requests pop up on the computer as they arrive, so they are not missed while the panel is closed. */
function PairingPrompt({ waiting, onDone }: { waiting: Waiting; onDone: () => void }): React.ReactElement | null {
  const dialog = React.useRef<HTMLDialogElement>(null)
  const [working, setWorking] = React.useState(false), [error, setError] = React.useState('')
  const request = waiting.requests[0]
  React.useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (request && !element.open) element.showModal()
    if (!request && element.open) element.close()
  }, [request])
  const answer = async (action: 'approve' | 'reject') => {
    if (!request) return
    setWorking(true); setError('')
    // Approving confirms the same device name and host fingerprint the pairing page displayed; the
    // Host checks both again before the device cookie is issued.
    try { await command(action === 'approve' ? { action, id: request.id, name: request.name, fingerprint: waiting.node.fingerprint } : { action, id: request.id }) } catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败。') }
    finally { setWorking(false); onDone() }
  }
  return h('dialog', { className: 'dsrc-dialog dsrc-prompt', ref: dialog, 'aria-labelledby': 'dsrc-pairing-title', onCancel: (event: React.SyntheticEvent) => event.preventDefault() },
    request ? block('div', 'dsrc', [
      h('h2', { id: 'dsrc-pairing-title', tabIndex: -1, autoFocus: true }, '新的配对请求'),
      h('p', { className: 'dsrc-prompt-device' }, request.name),
      h('p', { className: 'dsrc-note' }, `主机指纹 ${waiting.node.fingerprintGroups} · ${request.via === 'public' ? '公网入口' : '局域网'}${request.via === 'public' ? request.nodeConfirmed ? ' · 手机已确认本机' : ' · 手机尚未确认本机' : ''}`),
      h('p', { className: 'dsrc-note' }, '这台设备扫描了远程控制二维码。请核对设备名与主机指纹；允许后，它与本机拥有相同的权限，可以管理设置、凭据和插件。不是你本人操作请拒绝。'),
      waiting.requests.length > 1 ? h('p', { className: 'dsrc-note' }, `还有 ${waiting.requests.length - 1} 个请求在等待。`) : null,
      error ? block('div', 'dsrc-error', [error], { role: 'alert' }) : null,
      block('div', 'dsrc-actions dsrc-prompt-actions', [
        h('button', { type: 'button', className: 'dsrc-button', disabled: working, onClick: () => { void answer('reject') } }, '拒绝'),
        h('button', { type: 'button', className: 'dsrc-button dsrc-primary', disabled: working, autoFocus: true, onClick: () => { void answer('approve') } }, '允许连接')]),
    ]) : null)
}
function SidebarEntry({ manager }: PanelProps): React.ReactElement {
  const [open, setOpen] = React.useState(false), dialog = React.useRef<HTMLDialogElement>(null)
  const [waiting, setWaiting] = React.useState<Waiting>({ enabled: false, node: { name: '', fingerprint: '', fingerprintGroups: '' }, requests: [] })
  React.useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close() }, [open])
  React.useEffect(() => {
    const element = dialog.current, view = window.visualViewport
    if (!open || !element || !view) return
    // A soft keyboard shrinks the visual viewport without moving the layout viewport, so the dialog
    // is laid out against a height the keyboard then covers. Clamp it to what is actually visible.
    const sync = () => {
      if (view.height >= window.innerHeight - 80) { element.style.cssText = ''; return }
      element.style.position = 'fixed'
      element.style.top = `${Math.round(view.offsetTop + 8)}px`
      element.style.left = '8px'; element.style.right = '8px'; element.style.bottom = 'auto'
      element.style.width = 'auto'; element.style.margin = '0'
      element.style.maxHeight = `${Math.max(200, Math.round(view.height - 16))}px`
    }
    sync()
    view.addEventListener('resize', sync); view.addEventListener('scroll', sync)
    return () => { view.removeEventListener('resize', sync); view.removeEventListener('scroll', sync); element.style.cssText = '' }
  }, [open])
  const checking = React.useRef(false)
  const check = React.useCallback(async () => {
    // A slow tunnel answers later than the next tick; one probe in flight at a time keeps an older
    // answer from overwriting a newer one, and a hidden page does not need to ask at all.
    if (checking.current || document.hidden) return
    checking.current = true
    try {
      const next = await command({ action: 'requests' }) as unknown as Waiting
      setWaiting(next)
    } catch { /* the Host is restarting: ask again on the next tick */ }
    finally { checking.current = false }
  }, [])
  React.useEffect(() => {
    void check()
    const timer = setInterval(() => { void check() }, 2500)
    const wake = () => { if (!document.hidden) void check() }
    document.addEventListener('visibilitychange', wake)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', wake) }
  }, [check])
  const pending = waiting.requests.length > 0
  const button = h('button', { type: 'button', className: 'dsrc-entry', title: pending ? '远程控制 · 有配对请求' : '远程控制', 'aria-label': '远程控制', onClick: () => setOpen(true) }, icon(), pending ? h('span', { className: 'dsrc-entry-dot' }) : null)
  return h(React.Fragment, null,
    button,
    h('dialog', { className: 'dsrc-dialog', ref: dialog, 'aria-label': '远程控制', onCancel: () => setOpen(false), onClick: (event: React.MouseEvent<HTMLDialogElement>) => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) setOpen(false) } } },
      h('button', { type: 'button', className: 'dsrc-close', 'aria-label': '关闭远程控制面板', onClick: () => setOpen(false) }, '×'), open ? h(RemoteControlPanel, { manager }) : null),
    h(PairingPrompt, { waiting, onDone: () => { void check() } }))
}
export const inject = ['slots', 'connection']
export function apply(ctx: ClientContext): void {
  // `remote.pluginManager` is a Host Remote service mounted after this plugin applies. Its property gate
  // refuses a member that was not injected, so resolve the service by name on every check instead:
  // a Host without a plugin manager simply answers undefined and the card explains the manual path.
  const manager = () => {
    let found: unknown = undefined
    try { found = ctx.get?.('remote.pluginManager') } catch { found = undefined }
    return resolvePluginManager({ manager: (found ?? null) as PluginManagerFace | null })
  }
  ctx.effect(() => { const style = document.createElement('style'); style.dataset.dshRemoteControl = 'true'; style.textContent = CSS; document.head.append(style); return () => style.remove() }, 'remote-control styles')
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'copylee-remote-control', order: 65, label: () => '远程控制' }, () => h(RemoteControlPanel, { manager })))
  // Addressed by section id: the shell skips ids it has no section for.
  ctx.slots.inject('settings.section.icon', () => ctx.slots.register({ name: 'settings.section.icon', id: 'copylee-remote-control' }, (props: { size?: number; active?: boolean }) => h(PhoneIcon, props)))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'copylee-remote-control', order: 65 }, () => h(SidebarEntry, { manager })))
}
