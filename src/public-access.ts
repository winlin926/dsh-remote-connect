import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readPublicUrl, normalizePublicUrl, writePublicUrl } from './public-url-settings.js'
import { createCertificateManager, migrateLegacyAccountKey, type CertificateManager, type CertificateStatus } from './acme-certificate.js'
import { createOutboundProxy, type OutboundProxy } from './outbound-proxy.js'
import { PUBLIC_NODE_PROTOCOL, detectPublicNode, type PublicNodeDetection } from './public-node.js'

/** frpc forwards the public domain to this fixed port; a test run may point it elsewhere. */
export const PUBLIC_PORT = (() => {
  const override = Number(process.env.DSH_RC_PUBLIC_PORT)
  return Number.isInteger(override) && override > 0 && override < 65536 ? override : 43128
})()
export const FRPC_CERTIFICATE_DIR = join(process.env.ProgramData ?? 'C:\\ProgramData', 'SakuraFrpService', 'FrpcWorkingDirectory')

/** The three ways a public entry can fail, each with the line the panel shows. */
export type PublicUrlFailure = 'unreachable' | 'identity' | 'tls'
export const PUBLIC_UNREACHABLE_MESSAGE = '公网节点不可达，请确认隧道客户端正在运行，或检查域名配置。'
export const PUBLIC_IDENTITY_MESSAGE = '公网入口不是本机：节点指纹与这台电脑不一致，请检查域名或隧道是否指向这台电脑。'
export const PUBLIC_TLS_MESSAGE = '公网入口的证书或域名错误，请检查 HTTPS 证书和域名解析。'

export interface PublicUrlCheck { at: number; reachable: boolean; status: number | null; failure: PublicUrlFailure | null; error: string | null }
export interface PublicAccessOptions {
  storage: string
  legacyStorage: string
  proxy(): Promise<string | undefined>
  certificateDir?: string
  now?: () => number
  log?(message: string): void
  beforeIssue?(): Promise<void>
  /** The host identity the public entry must present; a tunnel that reaches another computer is refused. */
  identity: { hostId: string; fingerprint: string }
}

export class PublicAccess {
  readonly instanceId = randomUUID()
  domain: string | null
  readonly challengeDir: string
  readonly certificates: CertificateManager
  private readonly settingsFile: string
  private readonly now: () => number
  private outbound?: { address?: string; client: OutboundProxy }
  private active = false
  lastCheck?: PublicUrlCheck

  constructor(private readonly options: PublicAccessOptions) {
    this.now = options.now ?? Date.now
    this.settingsFile = join(options.storage, 'public-url.json')
    this.domain = existsSync(this.settingsFile) ? readPublicUrl(this.settingsFile) : readPublicUrl(join(options.legacyStorage, 'settings.json'))
    this.challengeDir = join(options.storage, 'acme', 'challenge')
    this.certificates = createCertificateManager({
      domain: () => this.domain ? new URL(this.domain).hostname : undefined,
      stateDir: join(options.storage, 'acme'), legacyStateDir: join(this.options.legacyStorage, 'acme'),
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

  setActive(active: boolean): void { this.active = active }
  certificateStatus(): Promise<CertificateStatus> { return this.certificates.status() }

  async migrate(): Promise<void> {
    if (!existsSync(this.settingsFile) && this.domain) await writePublicUrl(this.settingsFile, this.domain)
    await migrateLegacyAccountKey(join(this.options.storage, 'acme'), join(this.options.legacyStorage, 'acme'))
  }

  async saveDomain(raw: string): Promise<void> {
    const next = normalizePublicUrl(raw)
    if (next === this.domain) return
    await writePublicUrl(this.settingsFile, next)
    this.domain = next
    this.lastCheck = undefined
  }

  /**
   * Probe the public entry's discovery document and classify the failure for the panel. A reachable
   * document is not enough: its `kind`, `protocol`, `hostId` and `fingerprint` must be this computer's,
   * otherwise the domain points at another Host (or at a service that only looks like one).
   */
  async checkDomain(): Promise<PublicUrlCheck> {
    if (!this.domain) throw new Error('尚未配置公网域名。')
    const domain = this.domain
    const detection = await detectPublicNode(domain, { timeoutMs: 24_000, fetch: (url, init) => this.fetch(url, init) })
    const check = this.classify(detection)
    if (domain === this.domain) this.lastCheck = check
    return check
  }

  private classify(detection: PublicNodeDetection): PublicUrlCheck {
    const at = this.now()
    if (detection.ok) {
      const node = detection.node
      const same = node.kind === 'gateway' && node.protocol === PUBLIC_NODE_PROTOCOL && node.hostId === this.options.identity.hostId && node.fingerprint === this.options.identity.fingerprint
      return same
        ? { at, reachable: true, status: 200, failure: null, error: null }
        : { at, reachable: false, status: 200, failure: 'identity', error: PUBLIC_IDENTITY_MESSAGE }
    }
    switch (detection.code) {
      // The tunnel client is not running, the domain does not resolve, or nothing answers.
      case 'unreachable': return { at, reachable: false, status: null, failure: 'unreachable', error: PUBLIC_UNREACHABLE_MESSAGE }
      // A certificate, port or DNS misconfiguration: the request never reaches a valid node document.
      case 'not-https': case 'bad-url': case 'bad-tls': case 'redirect':
        return { at, reachable: false, status: null, failure: 'tls', error: PUBLIC_TLS_MESSAGE }
      // Something answered with an HTTP error (a tunnel error page, the wrong origin, a 404): the
      // public node is not reachable, and retrying once the tunnel is fixed is the right advice.
      case 'bad-response': return { at, reachable: false, status: null, failure: 'unreachable', error: PUBLIC_UNREACHABLE_MESSAGE }
      // Something answered, but not this gateway: another Host, another service, a wrong protocol.
      default: return { at, reachable: false, status: null, failure: 'identity', error: PUBLIC_IDENTITY_MESSAGE }
    }
  }

  private async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const address = await this.options.proxy()
    init?.signal?.throwIfAborted()
    if (!this.outbound || this.outbound.address !== address) {
      const previous = this.outbound
      this.outbound = { address, client: createOutboundProxy(address) }
      await previous?.client.close()
    }
    return this.outbound.client.fetch(input, init)
  }

  async resetOutbound(): Promise<void> {
    const previous = this.outbound; this.outbound = undefined
    await previous?.client.close()
  }
}
