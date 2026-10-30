import { randomInt, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readPublicUrl, normalizePublicUrl, writePublicUrl } from './public-url-settings.js'
import { createFilePairingPinStore, readLegacyPairingPin, type PairingPinStore } from './pairing-pin-store.js'
import { createCertificateManager, migrateLegacyAccountKey, type CertificateManager, type CertificateStatus } from './acme-certificate.js'
import { createOutboundProxy, type OutboundProxy } from './outbound-proxy.js'

/** frpc forwards the public domain to this fixed port; a test run may point it elsewhere. */
export const PUBLIC_PORT = (() => {
  const override = Number(process.env.DSH_RC_PUBLIC_PORT)
  return Number.isInteger(override) && override > 0 && override < 65536 ? override : 43128
})()
export const FRPC_CERTIFICATE_DIR = join(process.env.ProgramData ?? 'C:\\ProgramData', 'SakuraFrpService', 'FrpcWorkingDirectory')
const FAILURE_WINDOW = 10 * 60_000

export interface PublicUrlCheck { at: number; reachable: boolean; status: number | null; error: string | null }
export interface PublicAccessOptions {
  storage: string
  legacyStorage: string
  proxy(): Promise<string | undefined>
  certificateDir?: string
  now?: () => number
  log?(message: string): void
  beforeIssue?(): Promise<void>
}

export class PublicAccess {
  domain: string | null
  readonly challengeDir: string
  readonly certificates: CertificateManager
  private readonly settingsFile: string
  private readonly pins: PairingPinStore
  private readonly now: () => number
  private outbound?: { address?: string; client: OutboundProxy }
  private currentPin?: string
  private readonly failures = new Map<string, number[]>()
  private allFailures: number[] = []
  private renewals = new Map<string, Promise<void>>()
  private active = false
  lastCheck?: PublicUrlCheck

  constructor(private readonly options: PublicAccessOptions) {
    this.now = options.now ?? Date.now
    this.settingsFile = join(options.storage, 'public-url.json')
    this.domain = existsSync(this.settingsFile) ? readPublicUrl(this.settingsFile) : readPublicUrl(join(options.legacyStorage, 'settings.json'))
    const pinFile = join(options.storage, 'pairing-pin.json'), legacyPinFile = join(options.legacyStorage, 'mobile-pairing-pin.json')
    this.pins = createFilePairingPinStore(pinFile, legacyPinFile)
    const stored = this.pins.load()
    if (!existsSync(pinFile) && stored.pinConsent !== true) {
      const legacyPin = readLegacyPairingPin(join(options.legacyStorage, 'settings.json'))
      if (legacyPin) { this.pins.save({ pin: legacyPin, pinConsent: true }); stored.pin = legacyPin; stored.pinConsent = true }
    }
    this.currentPin = stored.pinConsent === true && stored.pin ? stored.pin : this.generate()
    this.challengeDir = join(options.storage, 'acme', 'challenge')
    this.certificates = createCertificateManager({
      domain: () => this.domain ? new URL(this.domain).hostname : undefined,
      stateDir: join(options.storage, 'acme'), legacyStateDir: join(options.legacyStorage, 'acme'),
      challengeDir: this.challengeDir, deployDir: options.certificateDir ?? FRPC_CERTIFICATE_DIR,
      proxyAddress: options.proxy,
      log: options.log,
      beforeIssue: async domain => {
        if (domain !== (this.domain ? new URL(this.domain).hostname : undefined)) throw new Error('公网域名已变更，请按新域名重新申请证书。')
        if (!this.active) throw new Error('远程连接未开启或公网监听已停止，不能申请证书。')
        await options.beforeIssue?.()
      }
    })
  }

  private generate(): string { return String(randomInt(0, 1_000_000)).padStart(6, '0') }
  get fixedPin(): boolean { const state = this.pins.load(); return state.pinConsent === true && !!state.pin }
  setActive(active: boolean): void { this.active = active }
  password(local: boolean): string | undefined { return local && this.domain ? this.currentPin : undefined }
  certificateStatus(): Promise<CertificateStatus> { return this.certificates.status() }

  async migrate(): Promise<void> {
    if (!existsSync(this.settingsFile) && this.domain) await writePublicUrl(this.settingsFile, this.domain)
    await migrateLegacyAccountKey(join(this.options.storage, 'acme'), join(this.options.legacyStorage, 'acme'))
  }

  private pruneFailures(): void {
    const cutoff = this.now() - FAILURE_WINDOW
    for (const [address, failures] of this.failures) {
      const recent = failures.filter(time => time > cutoff)
      if (recent.length) this.failures.set(address, recent); else this.failures.delete(address)
    }
    this.allFailures = this.allFailures.filter(time => time > cutoff)
  }

  async saveDomain(raw: string): Promise<void> {
    const next = normalizePublicUrl(raw)
    if (next === this.domain) return
    await writePublicUrl(this.settingsFile, next)
    this.domain = next
    this.lastCheck = undefined
    if (next && !this.currentPin) this.currentPin = this.generate()
  }

  async setPin(raw: string): Promise<boolean> {
    const value = raw.trim()
    if (value && !/^\d{6}$/.test(value)) throw new Error('连接密码必须是 6 位数字；留空可恢复随机密码。')
    const previous = this.currentPin
    this.pins.save(value ? { pin: value, pinConsent: true } : { pinConsent: false })
    this.currentPin = value || this.generate()
    this.failures.clear(); this.allFailures = []
    return previous !== this.currentPin
  }

  verifyPin(raw: string, address: string): { ok: boolean; retryAfter?: number } {
    this.pruneFailures()
    const retryAfter = this.retryAfter(address)
    if (retryAfter) return { ok: false, retryAfter }
    const expected = Buffer.from(this.currentPin ?? ''), received = Buffer.from(raw)
    const ok = expected.length === received.length && timingSafeEqual(expected, received)
    if (ok) { this.failures.delete(address); return { ok: true } }
    const now = this.now(), cutoff = now - FAILURE_WINDOW
    const previous = (this.failures.get(address) ?? []).filter(time => time > cutoff)
    previous.push(now); this.failures.set(address, previous)
    this.allFailures = this.allFailures.filter(time => time > cutoff); this.allFailures.push(now)
    return { ok: false, retryAfter: this.retryAfter(address) }
  }

  private retryAfter(address: string): number | undefined {
    const cutoff = this.now() - FAILURE_WINDOW
    const own = (this.failures.get(address) ?? []).filter(time => time > cutoff)
    this.failures.set(address, own)
    this.allFailures = this.allFailures.filter(time => time > cutoff)
    // One address must not lock every other phone out: the global ceiling only applies once
    // the failures are spread across several addresses.
    const globalLimited = this.allFailures.length >= 20 && this.failures.size >= 5
    const limited = own.length >= 5 || globalLimited
    if (!limited) return undefined
    const oldest = Math.min(...(own.length >= 5 ? [own[0]!] : []), ...(globalLimited ? [this.allFailures[0]!] : []))
    return Math.max(1, Math.ceil((oldest + FAILURE_WINDOW - this.now()) / 1000))
  }

  async checkDomain(): Promise<PublicUrlCheck> {
    if (!this.domain) throw new Error('尚未配置公网域名。')
    const domain = this.domain
    const address = domain + '/rc/health'
    let lastError = '网络请求失败'
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.fetch(address, { redirect: 'manual', signal: AbortSignal.timeout(12_000) })
        const identity = response.status === 200 ? await response.json().catch(() => null) : null
        const reachable = response.status === 200 && identity?.service === 'dsh-remote-connect'
        const error = reachable ? null : response.status >= 500 ? `HTTP ${response.status}` : '域名没有指向当前远程控制网关'
        const check = { at: this.now(), reachable, status: response.status, error }
        if (domain === this.domain) this.lastCheck = check
        return check
      } catch (error) { lastError = error instanceof Error ? error.message : String(error) }
    }
    if (domain === this.domain) this.lastCheck = { at: this.now(), reachable: false, status: null, error: lastError }
    return this.lastCheck!
  }

  private async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const address = await this.options.proxy()
    if (!this.outbound || this.outbound.address !== address) {
      const previous = this.outbound
      this.outbound = { address, client: createOutboundProxy(address) }
      await previous?.client.close()
    }
    return this.outbound.client.fetch(input, init)
  }

  async renew(domain: string, force: boolean): Promise<void> {
    const previous = this.renewals.get(domain)
    const task = (previous ?? Promise.resolve()).then(() => this.certificates.ensure(force).then(() => undefined))
    this.renewals.set(domain, task)
    try { await task } finally { if (this.renewals.get(domain) === task) this.renewals.delete(domain) }
  }

  async resetOutbound(): Promise<void> {
    const previous = this.outbound; this.outbound = undefined
    await previous?.client.close()
  }
}
