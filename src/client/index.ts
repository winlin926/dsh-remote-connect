import * as React from 'react'
import { createPortal } from 'react-dom'
import { CSS } from './style.js'
import type { Accent } from '../accent.js'
import { ACCENTS, ACCENT_IDS, installAccent, useAccent } from './shared-accent.js'
import { chooseAccent, syncAccent } from './accent-sync.js'
import { registerNavIcon } from './nav-icon.js'
import { mountInlineSidebarAction } from './sidebar-action.js'
const h = React.createElement
const ROUTE = '/api/dsh-remote-connect/manage'
interface Status {
  ui?: 'custom' | 'native'
  enabled: boolean; busy: boolean; mode: 'public' | 'lan'; activeMode?: 'public' | 'lan'; autoStart: boolean; proxyConfigured: boolean; proxyMode?: 'system' | 'manual' | 'off'; manualProxy?: string; systemProxy?: { url: string; source: string } | null; accent?: Accent
  publicUrl?: string | null; publicPort: number; pairingPin?: string; pinFixed?: boolean; passwordPairing?: boolean
  publicUrlCheck?: { at: number; reachable: boolean; status: number | null; error: string | null }
  certificate?: { domain?: string; expiresAt?: number; renewAt?: number; selfSigned: boolean; pending: boolean; restartRequired: boolean; error?: string }
  phase: string; error?: string; warning?: string; gatewayPort: number; local: boolean; expiresAt?: number; qr?: string
  links: Array<{ base: string; url?: string }>; requests: Array<{ id: string; name: string; expiresAt: number }>
  devices: Array<{ id: string; name: string; createdAt: number; lastSeenAt: number; online: boolean; via?: 'lan' | 'public' }>; lanHint: string
}
interface ClientContext {
  effect(run: () => void | (() => void), label?: string): void
  slots: { inject(name: string, setup: () => unknown): void; register(meta: Record<string, unknown>, render: (props: any) => unknown): unknown }
}
/** A panel request must never leave the poll or a button waiting forever on a dead network. */
function deadline(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return controller.signal
}
export async function command(input: Record<string, unknown>): Promise<Status> {
  const transport = (globalThis as unknown as { __DSH_TRANSPORT__?: { fetch?: typeof fetch } }).__DSH_TRANSPORT__?.fetch ?? fetch
  let response: Response
  try {
    response = await transport(ROUTE, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: deadline(10_000) })
  } catch (failure) {
    const name = (failure as { name?: string } | null)?.name
    throw new Error(name === 'AbortError' || name === 'TimeoutError' ? '和电脑的连接超时，请检查网络后重试。' : failure instanceof Error ? failure.message : '连接失败。')
  }
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? `连接失败（HTTP ${response.status}）`)
  return data as Status
}
type Way = 'public' | 'lan'
const WAYS: Array<{ mode: Way; name: string; text: string }> = [
  { mode: 'lan', name: '同一 Wi‑Fi', text: '同一网络直连，无需公网配置。' },
  { mode: 'public', name: '任意网络', text: '异地或移动网络，需固定域名。' },
]
const wayName = (mode: string | undefined) => WAYS.find(way => way.mode === mode)?.name ?? ''
function icon(): React.ReactNode { return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true }, h('rect', { x: 7, y: 2, width: 10, height: 20, rx: 3 }), h('path', { d: 'M10 5h4M11 19h2' })) }
function WayIcon({ mode }: { mode: Way }): React.ReactElement {
  return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    mode === 'lan'
      ? h(React.Fragment, null, h('path', { d: 'M3 9a14 14 0 0 1 18 0M6 13a9 9 0 0 1 12 0M9.5 16.5a4 4 0 0 1 5 0' }), h('circle', { cx: 12, cy: 20, r: .8, fill: 'currentColor', stroke: 0 }))
      : h(React.Fragment, null, h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M3 12h18M12 3c3 3.4 3 14.6 0 18M12 3c-3 3.4-3 14.6 0 18' })))
}
function moveRadio(event: React.KeyboardEvent<HTMLButtonElement>, index: number, count: number, choose: (index: number) => void): void {
  const offset = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0
  if (!offset && event.key !== 'Home' && event.key !== 'End') return
  event.preventDefault()
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : (index + offset + count) % count
  choose(next)
  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=radio]')[next]?.focus()
}
const when = (time: number) => new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const address = (value: string) => {
  try { const url = new URL(value); return url.origin + (url.pathname === '/' ? '' : url.pathname) }
  catch { return value }
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
        device.online ? h('span', { className: 'dsrc-tag dsrc-online' }, '在线') : null])
        : h('input', { className: 'dsrc-rename', 'aria-label': `重命名 ${device.name}`, autoFocus: true, maxLength: 40, value: name, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value), onBlur: () => finish(true), onKeyDown: (event: React.KeyboardEvent) => { if (event.key === 'Enter') finish(true); if (event.key === 'Escape') finish(false) } }),
      h('div', { className: 'dsrc-device-meta' }, `配对于 ${when(device.createdAt)} · 最近使用 ${when(device.lastSeenAt)}`)]),
    block('div', 'dsrc-actions', [
      h('button', { type: 'button', className: 'dsrc-button dsrc-ghost', disabled, onClick: () => { finished.current = false; setName(device.name) } }, '重命名'),
      h('button', { type: 'button', className: 'dsrc-button dsrc-danger', disabled, onClick: () => { if (confirm(`撤销“${device.name}”的授权？这台设备需要重新扫码配对。`)) void act('revoke', { id: device.id }) } }, '撤销授权')]),
  ])
}

export function RemoteControlPanel(): React.ReactElement {
  const [state, setState] = React.useState<Status | null>(null)
  const [error, setError] = React.useState('')
  const [statusError, setStatusError] = React.useState('')
  const [workingAction, setWorkingAction] = React.useState('')
  const [proxy, setProxy] = React.useState<string | null>(null)
  const [domain, setDomain] = React.useState<string | null>(null)
  const [pin, setPin] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState('')
  const [toast, setToast] = React.useState('')
  const toastTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const say = (text: string) => { setToast(text); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 2200) }
  React.useEffect(() => () => clearTimeout(toastTimer.current), [])
  const mounted = React.useRef(true), pending = React.useRef(false)
  const refresh = React.useCallback(async () => {
    if (pending.current) return
    pending.current = true
    try {
      const data = await command({ action: 'status' })
      if (mounted.current) { setState(data); setStatusError('') }
    } catch (failure) {
      if (mounted.current) setStatusError(failure instanceof Error ? failure.message : '状态读取失败。')
    } finally { pending.current = false }
  }, [])
  React.useEffect(() => {
    mounted.current = true; void refresh(); const timer = setInterval(() => { void refresh() }, 2000)
    return () => { mounted.current = false; clearInterval(timer) }
  }, [refresh])
  const act = async (action: string, fields: Record<string, unknown> = {}) => {
    setWorkingAction(action); setNotice(''); setError('')
    try {
      const data = await command({ action, ...fields })
      if (data.links) setState(data)
      if (action === 'certificate') setNotice('证书申请或续期已开始，状态会自动更新。')
      else if (action === 'switch') setNotice('已提交切换，当前访问即将断开。请使用新入口重新连接。')
      else if (action === 'stop') {
        setState(previous => previous ? { ...previous, enabled: false, activeMode: undefined, phase: 'off', links: [], requests: [], qr: undefined } : previous)
        setNotice('远程连接已关闭，设备授权保留。')
      } else if (['preferences', 'setPin', 'rename'].includes(action)) {
        setNotice(action === 'preferences' ? '设置已保存。' : action === 'setPin' ? '连接密码已更新，请重新配对设备。' : '设备名称已更新。')
        setTimeout(() => { void refresh() }, 200)
      } else if (['approve', 'reject', 'revoke', 'revokeAll'].includes(action)) setTimeout(() => { void refresh() }, 200)
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作失败。')
      return false
    } finally { setWorkingAction('') }
  }
  const copy = async (url: string, message = '已复制配对链接') => {
    try { await navigator.clipboard.writeText(url); setNotice(''); say(message) }
    catch { setNotice('浏览器不允许自动复制，请选中下方的完整链接手动复制。') }
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
  const pinDraft = pin ?? (state?.pinFixed ? state.pairingPin ?? '' : '')
  const pinInvalid = !!pinDraft && !/^\d{6}$/.test(pinDraft)
  const certificate = state?.certificate
  const certificateExpired = !!certificate?.expiresAt && certificate.expiresAt <= Date.now()
  const certificateLabel = state && !state.local ? '仅本机可管理' : !publicUrl ? '配置域名后可管理' : !certificate ? '正在读取证书状态' : certificate.pending ? '正在申请或续期' : certificateExpired ? '证书已过期' : certificate.selfSigned ? 'frpc 自签证书' : certificate.expiresAt ? `有效至 ${new Date(certificate.expiresAt).toLocaleDateString('zh-CN')}` : '尚未申请'
  // A renewed one-time pairing ticket does not invalidate already paired devices.
  const renewing = React.useRef(false)
  React.useEffect(() => {
    if (!state?.enabled || !expired || state.busy || renewing.current || state.requests.length) return
    renewing.current = true
    void command({ action: 'refresh' }).then(data => { if (mounted.current) setState(data) }, () => {}).finally(() => { renewing.current = false })
  }, [state, expired])
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
  const domainBlocked = shown === 'public' && !publicUrl
  React.useEffect(() => { if (domainBlocked) setSettingsOpen(true) }, [domainBlocked])
  const choose = (mode: Way) => {
    if (!state || disabled) return
    if (mode === 'public' && !publicUrl) {
      setAsking(null)
      setNotice(state.enabled ? '先保存固定公网域名，再切换到“任意网络”。' : '选择已保留。请填写固定公网域名，然后开启连接。')
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
  const [accent] = useAccent()
  React.useEffect(() => { syncAccent(state?.accent, next => { void act('preferences', { accent: next }) }) }, [state?.accent])
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
      shown === 'public' && state.local && state.publicUrlCheck && !state.publicUrlCheck.reachable ? h('p', { className: 'dsrc-error', role: 'alert' }, '公网入口当前不可达，现在扫码打不开。请先启动电脑上的 SakuraFrp / frpc 服务。') : null,
      block('div', 'dsrc-steps', ['手机相机扫码', shown === 'public' ? state.passwordPairing ? '输入密码直接进入' : '输入密码，本机确认' : '在本机确认配对', '继续会话与审批'].map((step, index) => block('span', 'dsrc-step', [h('span', { className: 'dsrc-number' }, String(index + 1)), h('span', null, step)], { key: step }))),
    ])
    const pairingPassword = shown === 'public' && state.local ? block('div', 'dsrc-pin', [
      block('div', 'dsrc-pin-head', [h('span', { className: 'dsrc-field-label' }, '连接密码'), h('span', { className: 'dsrc-pin-kind' }, state.pinFixed ? '固定' : '随机')]),
      pin === null ? block('div', 'dsrc-secret', [
        h('code', null, state.pairingPin ?? '------'),
        h('button', { type: 'button', className: 'dsrc-button dsrc-ghost', disabled: disabled || !state.pairingPin, onClick: () => { if (state.pairingPin) void copy(state.pairingPin, '已复制连接密码') } }, '复制'),
        h('button', { type: 'button', className: 'dsrc-button dsrc-ghost', disabled, onClick: () => setPin(state.pinFixed ? state.pairingPin ?? '' : '') }, state.pinFixed ? '修改' : '设为固定'),
      ]) : block('div', 'dsrc-input', [
        h('input', { 'aria-label': '固定连接密码', inputMode: 'numeric', maxLength: 6, placeholder: '6 位数字', value: pinDraft, 'aria-invalid': pinInvalid, disabled, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setPin(event.target.value.replace(/\D/g, '')) }),
        h('button', { type: 'button', className: 'dsrc-button dsrc-primary', disabled: disabled || pinInvalid, onClick: () => { if (confirm('修改连接密码会断开所有已授权手机，需要重新配对。继续？')) void act('setPin', { pin: pinDraft }).then(saved => { if (saved) setPin(null) }) } }, '保存'),
        h('button', { type: 'button', className: 'dsrc-button', disabled, onClick: () => setPin(null) }, '取消'),
      ]),
      h('p', { className: 'dsrc-note' }, pin === null ? '仅配对本人设备；修改密码会撤销授权。' : '留空恢复随机密码；保存将撤销授权。'),
      pinInvalid ? h('p', { className: 'dsrc-error' }, '连接密码必须是 6 位数字。') : null,
    ]) : shown === 'public' ? h('p', { className: 'dsrc-note dsrc-pin' }, '连接密码仅能在本机面板查看和修改。') : null
    const brief = block('div', 'dsrc-brief', [
      block('div', 'dsrc-connection-state', [
        h('strong', null, state.busy ? '正在启动连接…' : state.enabled ? online ? '手机已连接，可以继续使用' : '连接已就绪，等待手机扫码' : domainBlocked ? '还差一个固定公网域名' : '开启后，用手机继续操作'),
        h('p', null, state.enabled ? online ? `${online} 台设备在线；也可以继续配对其他手机。` : '已授权设备可直接使用，新手机请扫码。' : domainBlocked ? '域名通常只需配置一次，保存后回到这里开启。' : shown === 'public' ? `将通过 ${address(publicUrl)} 连接。` : '同一 Wi‑Fi 即可直连，授权设备可重复使用。'),
      ]),
      domainBlocked ? h(InlineNotice, { tone: 'warn', action: { label: '配置域名', onClick: () => openSettings(true) } }, '“任意网络”需要固定公网域名，在右侧“连接与外观设置”里填写。') : null,
      state.error ? block('div', 'dsrc-pane-message', [h(InlineNotice, { tone: 'danger' }, state.error)]) : null,
      shown === 'public' && state.publicUrlCheck && !state.publicUrlCheck.reachable ? block('div', 'dsrc-pane-message', [h(InlineNotice, { tone: 'warn', action: { label: '检查设置', onClick: () => openSettings() } }, '公网入口当前不可达：请确认电脑上的 SakuraFrp / frpc 服务正在运行、隧道已启动，且域名仍指向本机。')]) : null,
      block('div', 'dsrc-connection-actions', [state.enabled ? h('button', { type: 'button', className: 'dsrc-button dsrc-stop', disabled, onClick: stopConnection }, workingAction === 'stop' ? '正在关闭…' : '关闭远程连接')
        : h('button', { type: 'button', className: 'dsrc-button dsrc-primary dsrc-start', disabled, onClick: start }, state.busy || workingAction === 'start' ? '正在开启…' : domainBlocked ? '先配置域名' : '开启远程连接')]),
      h('label', { className: 'dsrc-toggle' }, h('input', { type: 'checkbox', checked: state.autoStart, disabled, onChange: (event: React.ChangeEvent<HTMLInputElement>) => { void act('preferences', { autoStart: event.target.checked }) } }), '随 DSH 自动开启'),
      pairingPassword,
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
      statusError ? block('div', 'dsrc-panel-message', [h('span', null, `状态更新失败，当前显示上次结果。${statusError}`), h('button', { type: 'button', className: 'dsrc-button', onClick: () => { void refresh() } }, '重试')], { 'data-tone': 'warn', role: 'alert' }) : null,
      error && error !== state.error ? block('div', 'dsrc-panel-message', [error], { 'data-tone': 'danger', role: 'alert' }) : null,
      state.warning ? block('div', 'dsrc-panel-message', [state.warning], { 'data-tone': 'warn', role: 'status' }) : null,
      notice ? block('div', 'dsrc-panel-message', [notice, firstURL && (!navigator.clipboard || notice.includes('手动复制')) ? h('textarea', { className: 'dsrc-copy-fallback', readOnly: true, 'aria-label': '完整配对链接，可全选复制', value: firstURL, onFocus: (event: React.FocusEvent<HTMLTextAreaElement>) => event.currentTarget.select() }) : null], { 'data-tone': 'info', role: 'status' }) : null,
    ], { 'data-section': 'connection', 'data-state': connectionState })
  }

  const settings = () => {
    if (!state) return null
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
        h('button', { type: 'button', className: 'dsrc-button', disabled: disabled || !state.local || !publicUrl || domainDirty, onClick: () => { void act('checkPublicUrl') } }, workingAction === 'checkPublicUrl' ? '正在检测…' : state.publicUrlCheck ? '重新检测' : '检测连通性'),
        h(StatusNote, { label: '域名', value: state.publicUrlCheck ? state.publicUrlCheck.reachable ? `可访问${state.publicUrlCheck.status ? ` · HTTP ${state.publicUrlCheck.status}` : ''}` : `无法访问${state.publicUrlCheck.error ? ` · ${state.publicUrlCheck.error}` : ''}` : state.local ? '尚未检测' : '仅本机可检测', tone: state.publicUrlCheck ? state.publicUrlCheck.reachable ? 'ok' : 'danger' : 'neutral' }),
      ]),
      block('div', 'dsrc-field dsrc-certificate', [
        block('div', 'dsrc-setting-row', [
          h(StatusNote, { label: 'HTTPS 证书', value: certificateLabel, tone: certificateExpired || certificate?.error ? 'danger' : certificate?.pending ? 'warn' : certificate?.expiresAt && !certificate.selfSigned ? 'ok' : 'neutral' }),
          h('button', { type: 'button', className: 'dsrc-button', disabled: disabled || !state.local || !publicUrl || !!certificate?.pending || !state.enabled || state.activeMode !== 'public', title: !state.enabled || state.activeMode !== 'public' ? '开启任意网络后可申请证书' : undefined, onClick: () => { void act('certificate') } }, certificate?.pending || workingAction === 'certificate' ? '处理中…' : certificate?.expiresAt && !certificateExpired && !certificate.selfSigned ? '续期证书' : '申请证书'),
        ]),
        certificate?.restartRequired ? h('p', { className: 'dsrc-note' }, '证书已部署，请在 SakuraFrp 中重载对应隧道。') : null,
        certificate?.error ? h('p', { className: 'dsrc-error' }, '证书错误：' + certificate.error) : null,
      ]),
      publicUrl ? h('label', { className: 'dsrc-check dsrc-direct' },
        h('input', { type: 'checkbox', checked: state.passwordPairing === true, disabled: disabled || !state.local, onChange: (event: React.ChangeEvent<HTMLInputElement>) => { void act('preferences', { passwordPairing: event.target.checked }) } }),
        block('span', 'dsrc-check-copy', [
          h('span', { className: 'dsrc-field-label' }, '密码直连配对'),
          h('span', { className: 'dsrc-note' }, '开启后，新设备在浏览器输入连接密码即可直接配对进入，无需扫码和电脑确认；建议配合固定密码使用。'),
        ])) : null,
    ], { 'aria-label': '公网连接' })
    const appearance = block('section', 'dsrc-setting-group', [
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
      block('div', 'dsrc-field dsrc-appearance', [
        h('span', { className: 'dsrc-field-label' }, '手机界面'),
        block('div', 'dsrc-mode', ([['custom', '自定义界面'], ['native', '原生界面']] as const).map(([id, title]) => h('button', { key: id, type: 'button', 'aria-pressed': (state.ui ?? 'custom') === id, disabled, onClick: () => { void act('preferences', { ui: id }).then(saved => { if (saved && !state.local) location.assign('/?ui=' + id) }) } }, title)), { role: 'group', 'aria-label': '手机界面' }),
        h('p', { className: 'dsrc-note' }, '选择后立即打开手机界面；在电脑上设置时，刷新手机页面后生效。无需重新配对。'),
      ]),
      block('div', 'dsrc-field dsrc-appearance', [
        h('span', { className: 'dsrc-field-label' }, '界面强调色'),
        block('div', 'dsrc-appearance-row', [
          block('span', 'dsrc-swatches', ACCENT_IDS.map((id, index) => h('button', {
            key: id, type: 'button', className: 'dsrc-swatch', role: 'radio', 'aria-checked': accent === id, tabIndex: accent === id ? 0 : -1, 'aria-label': ACCENTS[id].name, title: ACCENTS[id].name,
            style: { '--rc-swatch': ACCENTS[id].accent } as React.CSSProperties,
            onClick: () => { chooseAccent(id); void act('preferences', { accent: id }) },
            onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => moveRadio(event, index, ACCENT_IDS.length, next => { const selected = ACCENT_IDS[next]!; chooseAccent(selected); void act('preferences', { accent: selected }) }),
          })), { role: 'radiogroup', 'aria-label': '界面强调色' }),
          h('span', { className: 'dsrc-muted' }, '对全部 copylee 插件生效'),
        ]),
      ]),
    ], { 'aria-label': '代理与外观' })
    return h('details', { className: 'dsrc-surface dsrc-preferences', 'data-needed': !!settingsIssue, open: settingsOpen, onToggle: (event: React.SyntheticEvent<HTMLDetailsElement>) => setSettingsOpen(event.currentTarget.open) },
      h('summary', null,
        block('span', 'dsrc-settings-title', [cardIcon('slate', h(GearIcon, null)), '连接与外观设置']),
        h('span', { className: `dsrc-summary-value${settingsIssue ? ' dsrc-needs-attention' : ''}` }, settingsIssue || `${publicUrl ? '域名已配置' : '域名未配置'} · ${(state.ui ?? 'custom') === 'custom' ? '自定义界面' : '原生界面'} · ${ACCENTS[accent].name}`)),
      block('div', 'dsrc-preferences-body', [publicSettings, appearance]))
  }
  const requests = () => state?.local && state.requests.length ? block('section', 'dsrc-surface dsrc-requests', [
    block('div', 'dsrc-card-head', [
      cardIcon('warm', h(BellIcon, null)),
      h('h3', null, '待确认配对'),
      h('span', { className: 'dsrc-tag dsrc-pending' }, `${state.requests.length} 项`),
    ]),
    h('p', { className: 'dsrc-note' }, '手机正在等待本机确认；仅允许本人设备。'),
    ...state.requests.map(request => block('div', 'dsrc-device dsrc-row', [
      block('div', 'dsrc-device-main', [block('div', 'dsrc-device-name', [request.name]), h('div', { className: 'dsrc-muted' }, '请求访问此电脑')]),
      block('div', 'dsrc-actions', [button('拒绝', 'reject', { id: request.id }), button('允许连接', 'approve', { id: request.id }, 'dsrc-primary')]),
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
    h('p', { className: 'dsrc-note' }, '不同连接方式分别记录授权；连续 30 天未使用的授权会过期。'),
  ], { 'data-section': 'devices' }) : null
  return block('div', 'dsrc', [
    h('header', { className: 'dsrc-head' }, block('div', '', [h('h2', null, '远程控制'), h('p', { className: 'dsrc-sub' }, '用手机浏览器继续电脑上的会话与审批。')]),
      h('span', { className: 'dsrc-badge', 'data-state': connectionState, role: 'status' }, h('span', { className: 'dsrc-dot' }), connectionLabel)),
    block('div', 'dsrc-layout', [
      block('div', 'dsrc-col dsrc-col-main', [main()]),
      block('div', 'dsrc-col dsrc-col-rail', [requests(), devices(), settings()]),
    ]),
    toast ? block('div', 'dsrc-toast', [h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'm5 12 5 5 9-10' })), toast], { role: 'status', 'aria-live': 'polite' }) : null,
  ], { 'data-dsh-plugin': 'dsh-remote-connect' })
}
interface Waiting { enabled: boolean; accent?: Accent; requests: Array<{ id: string; name: string; expiresAt: number }> }

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
  }, [request?.id])
  const answer = async (action: 'approve' | 'reject') => {
    if (!request) return
    setWorking(true); setError('')
    try { await command({ action, id: request.id }) } catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败。') }
    finally { setWorking(false); onDone() }
  }
  return h('dialog', { className: 'dsrc-dialog dsrc-prompt', ref: dialog, onCancel: (event: React.SyntheticEvent) => event.preventDefault() },
    request ? block('div', 'dsrc', [
      h('h2', null, '新的配对请求'),
      h('p', { className: 'dsrc-prompt-device' }, request.name),
      h('p', { className: 'dsrc-note' }, '这台设备扫描了远程控制二维码。允许后，它与本机拥有相同的权限，可以管理设置、凭据和插件。不是你本人操作请拒绝。'),
      waiting.requests.length > 1 ? h('p', { className: 'dsrc-note' }, `还有 ${waiting.requests.length - 1} 个请求在等待。`) : null,
      error ? block('div', 'dsrc-error', [error], { role: 'alert' }) : null,
      block('div', 'dsrc-actions dsrc-prompt-actions', [
        h('button', { type: 'button', className: 'dsrc-button', disabled: working, onClick: () => { void answer('reject') } }, '拒绝'),
        h('button', { type: 'button', className: 'dsrc-button dsrc-primary', disabled: working, autoFocus: true, onClick: () => { void answer('approve') } }, '允许连接')]),
    ]) : null)
}
function SidebarEntry({ wide }: { wide?: boolean }): React.ReactElement {
  const anchor = React.useRef<HTMLSpanElement>(null)
  const [inlineTarget, setInlineTarget] = React.useState<HTMLElement | null>(null)
  React.useLayoutEffect(() => {
    setInlineTarget(null)
    if (wide && anchor.current) return mountInlineSidebarAction(anchor.current, setInlineTarget)
  }, [wide])
  const [open, setOpen] = React.useState(false), dialog = React.useRef<HTMLDialogElement>(null)
  const [waiting, setWaiting] = React.useState<Waiting>({ enabled: false, requests: [] })
  React.useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close() }, [open])
  const check = React.useCallback(async () => {
    try {
      const next = await command({ action: 'requests' }) as unknown as Waiting
      setWaiting(next)
      syncAccent(next.accent, accent => { void command({ action: 'preferences', accent }).catch(() => {}) })
    } catch { /* the Host is restarting: ask again on the next tick */ }
  }, [])
  React.useEffect(() => { void check(); const timer = setInterval(() => { void check() }, 2500); return () => clearInterval(timer) }, [check])
  const pending = waiting.requests.length > 0
  const button = h('button', { type: 'button', className: 'dsrc-entry', title: pending ? '远程控制 · 有配对请求' : '远程控制', 'aria-label': '远程控制', onClick: () => setOpen(true) }, icon(), pending ? h('span', { className: 'dsrc-entry-dot' }) : null)
  return h(React.Fragment, null,
    h('span', { className: 'dsrc-entry-anchor', ref: anchor }, inlineTarget ? createPortal(button, inlineTarget) : button),
    h('dialog', { className: 'dsrc-dialog', ref: dialog, onCancel: () => setOpen(false), onClick: (event: React.MouseEvent<HTMLDialogElement>) => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) setOpen(false) } } },
      h('button', { type: 'button', className: 'dsrc-close', 'aria-label': '关闭远程控制面板', onClick: () => setOpen(false) }, '×'), open ? h(RemoteControlPanel) : null),
    h(PairingPrompt, { waiting, onDone: () => { void check() } }))
}
export const inject = ['slots', 'connection']
export function apply(ctx: ClientContext): void {
  ctx.effect(() => installAccent(), 'remote-control accent colour')
  ctx.effect(() => { const style = document.createElement('style'); style.dataset.dshRemoteControl = 'true'; style.textContent = CSS; document.head.append(style); return () => style.remove() }, 'remote-control styles')
  ctx.effect(() => registerNavIcon('远程控制'), 'remote-control: settings nav icon')
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'copylee-remote-control', order: 65, label: () => '远程控制' }, () => h(RemoteControlPanel)))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'copylee-remote-control', order: 65 }, (props: { wide?: boolean }) => h(SidebarEntry, { wide: props?.wide })))
}
