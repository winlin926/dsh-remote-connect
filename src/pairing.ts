import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const random = () => randomBytes(32).toString('base64url')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const matches = (value: string, expected: string) => {
  const a = Buffer.from(hash(value), 'hex'), b = Buffer.from(expected, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}
export const IDLE_MS = 30 * 24 * 3600_000
/** The entry a device was paired through. A public entry needs both ends' confirmation. */
export type PairingEntry = 'lan' | 'public'
export interface Device {
  id: string; name: string; createdAt: number; lastSeenAt: number; hash: string
  /** The address the device paired through, shown in the panel; the browser scopes its cookie to that origin. */
  host?: string
  /** Which entry paired it; absent on records written before the public double-confirmation flow. */
  via?: PairingEntry
  /**
   * A public-entry authorization from before the double-confirmation flow: still readable in the
   * panel with its device name, but never accepted again — the device must pair afresh.
   */
  requiresRepair?: boolean
}
interface Pending {
  id: string; name: string; host?: string; via: PairingEntry; expiresAt: number; keyHash: string
  state: 'pending' | 'approved' | 'rejected'; credential?: string; collected?: boolean
  /** True only after the browser confirmed the host fingerprint on the public pairing page. */
  nodeConfirmed: boolean
}
/** A refused confirmation, kept in memory for the panel; never persisted. */
export interface PairingFailure { at: number; name: string; reason: string }
export interface PublicDeviceMigration { marked: number; already: number; devices: number }

/** A name a person can tell devices apart by: model (or system) and browser, from the User-Agent. */
export function deviceName(userAgent: string, reported?: string): string {
  const system = /iPad/.test(userAgent) ? 'iPad' : /iPhone/.test(userAgent) ? 'iPhone' : /Android/.test(userAgent) ? 'Android' : /Windows/.test(userAgent) ? 'Windows' : /Mac OS X/.test(userAgent) ? 'Mac' : /Linux/.test(userAgent) ? 'Linux' : '远程设备'
  // Chrome's reduced User-Agent reports every Android model as "K".
  // The model the browser reports on request (secure pages only) is the real one; printable characters only.
  const hinted = reported?.replace(/[^\p{L}\p{N} ._()+-]/gu, '').trim()
  const model = hinted || /Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?[;)]/.exec(userAgent)?.[1]?.trim()
  const browsers: Array<[RegExp, string]> = [
    [/MicroMessenger/, '微信'], [/EdgA?\/|EdgiOS/, 'Edge'], [/Quark/, '夸克'], [/HuaweiBrowser/, '华为浏览器'], [/MiuiBrowser/, '小米浏览器'],
    [/SamsungBrowser/, '三星浏览器'], [/VivoBrowser/, 'vivo 浏览器'], [/HeyTapBrowser/, 'OPPO 浏览器'], [/Firefox|FxiOS/, 'Firefox'],
    [/Chrome|CriOS/, 'Chrome'], [/Safari/, 'Safari'],
  ]
  const browser = browsers.find(([pattern]) => pattern.test(userAgent))?.[1]
  const device = model && model !== 'K' && model.length <= 40 ? model : system
  return browser ? `${device} · ${browser}` : device
}
export interface PairingOptions {
  file: string; now?: () => number; onRevoke?: (id: string) => void; idleMs?: number; isOnline?: (id: string) => boolean
}
export const MAX_DEVICES = 32

/** The comparable host of a recorded entry: lower-case, with the port the browser used. */
function hostKey(value: string): string | undefined {
  const text = value.trim().toLowerCase()
  if (!text) return undefined
  try {
    // The configured public entry is a full origin; recorded device hosts are bare host[:port].
    return /^[a-z][a-z0-9+.-]*:\/\//.test(text) ? new URL(text).host : new URL(`http://${text}`).host
  } catch { return text }
}
/** The same host without its port, for a public domain whose recorded port may differ. */
function hostName(value: string): string | undefined {
  const key = hostKey(value)
  if (!key) return undefined
  try { return new URL(`http://${key}`).hostname } catch { return key }
}

/** Only hashes of device secrets reach disk. Pending claims live in memory. */
export class PairingService {
  private readonly devices = new Map<string, Device>()
  private readonly pending = new Map<string, Pending>()
  private token?: { hash: string; expiresAt: number }
  private failureState?: PairingFailure
  private readonly now: () => number
  readonly idleMs: number
  constructor(private readonly options: PairingOptions) {
    this.now = options.now ?? Date.now
    this.idleMs = options.idleMs ?? IDLE_MS
    if (existsSync(options.file)) {
      const input: unknown = JSON.parse(readFileSync(options.file, 'utf8'))
      if (!input || typeof input !== 'object' || !('devices' in input) || !Array.isArray(input.devices)) throw new Error('设备授权文件格式不正确，请备份后修复；不会忽略损坏的授权记录。')
      for (const row of input.devices) {
        if (!row || typeof row.id !== 'string' || typeof row.name !== 'string' || !/^[a-f0-9]{64}$/.test(row.hash) || !Number.isFinite(row.lastSeenAt) || !Number.isFinite(row.createdAt) || (row.host !== undefined && typeof row.host !== 'string') || (row.via !== undefined && row.via !== 'lan' && row.via !== 'public') || (row.requiresRepair !== undefined && typeof row.requiresRepair !== 'boolean')) throw new Error('设备授权记录损坏。')
        this.devices.set(row.id, row)
      }
      this.expire()
    }
  }
  private save(): void {
    mkdirSync(dirname(this.options.file), { recursive: true })
    const temporary = `${this.options.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, devices: [...this.devices.values()] }), { mode: 0o600 })
      renameSync(temporary, this.options.file)
    } catch (error) { if (existsSync(temporary)) unlinkSync(temporary); throw error }
  }
  private expire(): void {
    const expired = [...this.devices.values()].filter(d => this.now() - d.lastSeenAt >= this.idleMs)
    if (expired.length) {
      for (const device of expired) this.devices.delete(device.id)
      try { this.save() } catch (error) { for (const device of expired) this.devices.set(device.id, device); throw error }
      for (const device of expired) this.disconnectDevice(device.id)
    }
    for (const [id, claim] of this.pending) if (this.now() >= claim.expiresAt) this.pending.delete(id)
  }
  issue(): { token: string; expiresAt: number } {
    const token = random(), expiresAt = this.now() + 5 * 60_000
    this.token = { hash: hash(token), expiresAt }
    // A refresh also invalidates outstanding claims from the previous QR.
    this.pending.clear()
    this.failureState = undefined
    return { token, expiresAt }
  }
  invalidate(): void { this.token = undefined; this.pending.clear() }
  request(token: string, userAgent: string, host?: string, model?: string, via: PairingEntry = 'lan', nodeConfirmed = false): { id: string; key: string; expiresAt: number } {
    this.expire()
    if (!this.token || this.now() >= this.token.expiresAt || !matches(token, this.token.hash)) throw new Error('二维码已过期或已刷新，请重新扫码。')
    if (this.outstanding() >= 16) throw new Error('等待配对的设备过多，请稍后再试。')
    const id = randomUUID(), key = random(), expiresAt = Math.min(this.now() + 5 * 60_000, this.token.expiresAt)
    this.pending.set(id, { id, name: deviceName(userAgent, model), host: host?.toLowerCase(), via, expiresAt, keyHash: hash(key), state: 'pending', nodeConfirmed: via === 'lan' || nodeConfirmed })
    this.failureState = undefined
    return { id, key, expiresAt }
  }
  requests(): Array<{ id: string; name: string; via: PairingEntry; nodeConfirmed: boolean; expiresAt: number }> {
    this.expire()
    return [...this.pending.values()].filter(p => p.state === 'pending').map(({ id, name, via, nodeConfirmed, expiresAt }) => ({ id, name, via, nodeConfirmed, expiresAt }))
  }
  /** Claims a new ticket would strand: waiting for approval, or approved but not yet collected. */
  outstanding(): number { this.expire(); return [...this.pending.values()].filter(p => p.state === 'pending' || p.state === 'approved' && !p.collected).length }
  /** Records a refused confirmation so the panel can say why, instead of failing silently. */
  reportFailure(name: string, reason: string): void { this.failureState = { at: this.now(), name: name.trim().slice(0, 40), reason: reason.slice(0, 200) } }
  failure(): PairingFailure | undefined { return this.failureState }
  approve(id: string): void {
    this.expire()
    const claim = this.pending.get(id)
    if (!claim || claim.state !== 'pending') throw new Error('配对请求已失效。')
    // The public entry requires both ends: the browser confirmed this host's fingerprint, and the
    // computer's panel confirms the same device and the same fingerprint before a cookie is issued.
    if (claim.via === 'public' && !claim.nodeConfirmed) throw new Error('浏览器还没有确认本机指纹，请重新打开配对页确认。')
    const credential = this.registerDevice(claim.name, claim.host, claim.via)
    claim.state = 'approved'
    claim.credential = credential
    this.failureState = undefined
  }
  private registerDevice(name: string, host?: string, via?: PairingEntry): string {
    let replaced: Device | undefined
    if (this.devices.size >= MAX_DEVICES) {
      replaced = [...this.devices.values()].filter(d => !this.options.isOnline?.(d.id)).sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0]
      if (!replaced) throw new Error(`已有 ${MAX_DEVICES} 台设备在线，请先撤销不再使用的设备。`)
    }
    const deviceId = randomUUID(), secret = random(), now = this.now()
    const device: Device = { id: deviceId, name, hash: hash(secret), createdAt: now, lastSeenAt: now, ...(host ? { host: host.toLowerCase() } : {}), ...(via ? { via } : {}) }
    if (replaced) this.devices.delete(replaced.id)
    this.devices.set(deviceId, device)
    try { this.save() } catch (error) {
      this.devices.delete(deviceId)
      if (replaced) this.devices.set(replaced.id, replaced)
      throw error
    }
    if (replaced) this.disconnectDevice(replaced.id)
    return `${deviceId}.${secret}`
  }
  reject(id: string): void {
    const claim = this.pending.get(id)
    if (claim?.state === 'pending') claim.state = 'rejected'
  }
  claim(id: string, key: string): { state: 'pending' | 'approved' | 'rejected'; credential?: string } {
    this.expire()
    const claim = this.pending.get(id)
    if (!claim || !matches(key, claim.keyHash)) throw new Error('配对请求已失效。')
    const result = { state: claim.state, credential: claim.credential }
    if (claim.state === 'approved') claim.collected = true
    else if (claim.state === 'rejected') this.pending.delete(id)
    return result
  }
  authenticate(credential: string | undefined): Device | undefined {
    this.expire()
    if (!credential || credential.length > 128) return undefined
    const [id, secret, extra] = credential.split('.')
    if (!id || !secret || extra) return undefined
    const device = this.devices.get(id)
    // An old public-entry authorization is readable in the panel but never lets the browser in.
    if (!device || device.requiresRepair || !matches(secret, device.hash)) return undefined
    // Bound disk writes while preserving sliding idle expiry across restarts.
    if (this.now() - device.lastSeenAt >= 60_000) {
      const previous = device.lastSeenAt
      device.lastSeenAt = this.now()
      try { this.save() } catch (error) { device.lastSeenAt = previous; throw error }
    }
    return device
  }
  list(): Array<Omit<Device, 'hash'>> { this.expire(); return [...this.devices.values()].map(({ hash: _hash, ...device }) => device) }
  revoke(id: string): void {
    const previous = this.devices.get(id)
    if (!previous) return
    this.devices.delete(id)
    try { this.save() } catch (error) { this.devices.set(id, previous); throw error }
    this.disconnectDevice(id)
  }
  private disconnectDevice(id: string): void {
    this.options.onRevoke?.(id)
    // Do not let an approved-but-unclaimed request restore a revoked device.
    for (const [key, claim] of this.pending) if (claim.credential?.startsWith(`${id}.`)) this.pending.delete(key)
  }
  rename(id: string, name: string): void {
    const device = this.devices.get(id), next = name.trim().slice(0, 40)
    if (!device) throw new Error('设备不存在或已撤销。')
    if (!next) throw new Error('设备名称不能为空。')
    const previous = device.name
    device.name = next
    try { this.save() } catch (error) { device.name = previous; throw error }
  }
  /** Remove every device the test matches, e.g. those paired through an address that no longer exists. */
  prune(gone: (device: Omit<Device, 'hash'>) => boolean): void {
    for (const device of [...this.devices.values()]) if (gone(device)) { try { this.revoke(device.id) } catch { /* kept until the next start */ } }
  }
  /**
   * One explicit migration for authorizations issued through a public entry before the
   * double-confirmation flow: mark them `requiresRepair` (device names and records stay readable),
   * so an upgrade cannot keep letting them in with an old cookie. LAN authorizations are untouched,
   * and a second run marks nothing. The file keeps `version: 1`; the new fields are optional.
   */
  migratePublicDevices(publicHosts: readonly string[]): PublicDeviceMigration {
    const hosts = new Set<string>()
    for (const value of publicHosts) {
      const key = hostKey(value), name = hostName(value)
      if (key) hosts.add(key)
      if (name) hosts.add(name)
    }
    let marked = 0, already = 0
    for (const device of this.devices.values()) {
      // A device paired after this flow is accepted by both ends and needs no repair.
      if (device.via !== undefined || !device.host) continue
      const key = hostKey(device.host), name = hostName(device.host)
      if (!(key && hosts.has(key)) && !(name && hosts.has(name))) continue
      if (device.requiresRepair) { already += 1; continue }
      device.requiresRepair = true
      marked += 1
    }
    if (marked) this.save()
    return { marked, already, devices: this.devices.size }
  }
  revokeAll(): void {
    const previous = [...this.devices.values()]
    this.devices.clear()
    try { this.save() } catch (error) { for (const device of previous) this.devices.set(device.id, device); throw error }
    for (const device of previous) this.disconnectDevice(device.id)
    this.invalidate()
  }
}
