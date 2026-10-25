import { randomUUID, X509Certificate } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants as fsConstants, existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { HttpsProxyAgent } from 'https-proxy-agent'

export const ACME_CHALLENGE_PREFIX = '/.well-known/acme-challenge/'
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000
const RENEW_INTERVAL_MS = 12 * 60 * 60 * 1000
const execFileAsync = promisify(execFile)

export interface CertificateStatus {
  domain?: string
  certificatePath?: string
  keyPath?: string
  expiresAt?: number
  renewAt?: number
  selfSigned: boolean
  pending: boolean
  restartRequired: boolean
  error?: string
}

export interface CertificateManager {
  status(): Promise<CertificateStatus>
  ensure(force?: boolean): Promise<CertificateStatus>
  startAutoRenew(): void
  stop(): Promise<void>
}

export interface CertificateManagerOptions {
  domain(): string | undefined
  stateDir: string
  legacyStateDir?: string
  challengeDir: string
  deployDir: string
  proxyAddress?: () => Promise<string | undefined>
  directoryUrl?: string
  now?(): number
  log?(message: string): void
  beforeIssue?(domain: string): Promise<void>
  issue?(request: { domain: string; challengeDir: string }): Promise<{ certificate: string; key: string }>
}

export async function readDeployedCertificate(path: string): Promise<{ expiresAt: number; selfSigned: boolean } | undefined> {
  try {
    const certificate = new X509Certificate(await readFile(path, 'utf8'))
    const expiresAt = Date.parse(certificate.validTo) || undefined
    return expiresAt ? { expiresAt, selfSigned: certificate.issuer === certificate.subject } : undefined
  } catch { return undefined }
}

export function createCertificateManager(options: CertificateManagerOptions): CertificateManager {
  const now = options.now ?? Date.now
  let pending = false
  let renewedDomain: string | undefined
  let lastError: { message: string; domain: string } | undefined
  let running: Promise<CertificateStatus> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const paths = (domain: string) => ({
    certificatePath: join(options.deployDir, `${domain}.crt`),
    keyPath: join(options.deployDir, `${domain}.key`)
  })

  async function status(): Promise<CertificateStatus> {
    const domain = options.domain()
    if (!domain) return { selfSigned: false, pending, restartRequired: false }
    const target = paths(domain)
    const deployed = await readDeployedCertificate(target.certificatePath)
    return {
      domain,
      ...target,
      ...(deployed ? { expiresAt: deployed.expiresAt, renewAt: deployed.expiresAt - RENEW_BEFORE_MS } : {}),
      selfSigned: deployed?.selfSigned === true,
      pending,
      restartRequired: renewedDomain === domain,
      ...(lastError?.domain === domain ? { error: lastError.message } : {})
    }
  }

  async function ensureOnce(force: boolean): Promise<CertificateStatus> {
    const domain = options.domain()
    if (!domain) throw new Error('还没有配置固定公网域名。')
    const current = await status()
    if (!force && !current.selfSigned && current.expiresAt && current.expiresAt - now() > RENEW_BEFORE_MS) return current
    pending = true
    try {
      await options.beforeIssue?.(domain)
      const issued = options.issue
        ? await options.issue({ domain, challengeDir: options.challengeDir })
        : await requestCertificate({
            domain,
            challengeDir: options.challengeDir,
            stateDir: options.stateDir,
            legacyStateDir: options.legacyStateDir,
            directoryUrl: options.directoryUrl,
            proxyAddress: options.proxyAddress
          })
      if (options.domain() !== domain) throw new Error('公网域名已变更，本次证书不会部署；请按新域名重新申请。')
      await options.beforeIssue?.(domain)
      await deployCertificate(paths(domain), issued)
      renewedDomain = domain
      lastError = undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      lastError = { message, domain }
      options.log?.(`证书签发失败：${message}`)
      throw error
    } finally { pending = false }
    return status()
  }

  function ensure(force = false): Promise<CertificateStatus> {
    if (!running) running = ensureOnce(force).finally(() => { running = undefined })
    return running
  }

  return {
    status,
    ensure,
    startAutoRenew() {
      if (timer) return
      timer = setInterval(() => { void ensure().catch(() => undefined) }, RENEW_INTERVAL_MS)
      timer.unref?.()
    },
    async stop() {
      if (timer) clearInterval(timer)
      timer = undefined
      await running?.catch(() => undefined)
    }
  }
}

/** Replace both files only after the complete certificate and key are ready. */
export async function deployCertificate(
  target: { certificatePath: string; keyPath: string },
  issued: { certificate: string; key: string },
  replaceFile: (source: string, destination: string) => Promise<void> = rename
): Promise<void> {
  await mkdir(join(target.certificatePath, '..'), { recursive: true })
  const token = randomUUID()
  const certificateTemporary = `${target.certificatePath}.${token}.tmp`
  const keyTemporary = `${target.keyPath}.${token}.tmp`
  const [previousCertificate, previousKey] = await Promise.all([
    readFile(target.certificatePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }),
    readFile(target.keyPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
  ])
  let certificateReplacementAttempted = false
  let keyReplacementAttempted = false
  try {
    await writeFile(certificateTemporary, issued.certificate, { flag: 'wx' })
    await writeFile(keyTemporary, issued.key, { mode: 0o600, flag: 'wx' })
    await restrictPrivateKeyAcl(keyTemporary)
    certificateReplacementAttempted = true
    await replaceFile(certificateTemporary, target.certificatePath)
    keyReplacementAttempted = true
    await replaceFile(keyTemporary, target.keyPath)
  } catch (error) {
    const rollbackErrors: unknown[] = []
    if (certificateReplacementAttempted) {
      await restoreDeployedFile(target.certificatePath, previousCertificate, false)
        .catch(failure => { rollbackErrors.push(failure) })
    }
    if (keyReplacementAttempted) {
      await restoreDeployedFile(target.keyPath, previousKey, true)
        .catch(failure => { rollbackErrors.push(failure) })
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], '证书部署失败，且旧证书未能完整恢复。')
    throw error
  } finally {
    await Promise.all([
      rm(certificateTemporary, { force: true }),
      rm(keyTemporary, { force: true })
    ]).catch(() => undefined)
  }
}

async function restoreDeployedFile(path: string, content: Buffer | undefined, privateKey: boolean): Promise<void> {
  if (!content) {
    await rm(path, { force: true })
    return
  }
  const temporary = `${path}.${randomUUID()}.rollback`
  try {
    await writeFile(temporary, content, { mode: privateKey ? 0o600 : 0o644, flag: 'wx' })
    if (privateKey) await restrictPrivateKeyAcl(temporary)
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }).catch(() => undefined) }
}

async function requestCertificate(request: {
  domain: string
  challengeDir: string
  stateDir: string
  legacyStateDir?: string
  directoryUrl?: string
  proxyAddress?: () => Promise<string | undefined>
}): Promise<{ certificate: string; key: string }> {
  const acme = await import('acme-client')
  const axios = acme.axios
  const defaults = { httpsAgent: axios.defaults.httpsAgent, proxy: axios.defaults.proxy }
  try {
    const proxyAddress = await request.proxyAddress?.()
    if (proxyAddress) {
      axios.defaults.httpsAgent = new HttpsProxyAgent(proxyAddress)
      axios.defaults.proxy = false
    }
    const accountKey = await readOrCreateAccountKey(request.stateDir, request.legacyStateDir)
    const client = new acme.Client({
      directoryUrl: request.directoryUrl ?? acme.directory.letsencrypt.production,
      accountKey
    })
    await client.createAccount({ termsOfServiceAgreed: true })
    const [key, csr] = await acme.crypto.createCsr({
      commonName: request.domain,
      altNames: [request.domain]
    })
    const certificate = await client.auto({
      csr,
      termsOfServiceAgreed: true,
      challengePriority: ['http-01'],
      challengeCreateFn: async (_authorization, challenge, keyAuthorization) => {
        await mkdir(request.challengeDir, { recursive: true })
        await writeFile(join(request.challengeDir, challenge.token), keyAuthorization)
      },
      challengeRemoveFn: async (_authorization, challenge) => {
        await unlink(join(request.challengeDir, challenge.token)).catch(() => undefined)
      }
    })
    return { certificate, key: key.toString() }
  } finally { Object.assign(axios.defaults, defaults) }
}

export async function migrateLegacyAccountKey(stateDir: string, legacyStateDir?: string): Promise<boolean> {
  if (!legacyStateDir) return false
  const legacy = join(legacyStateDir, 'acme-account.key')
  const target = join(stateDir, 'acme-account.key')
  if (!existsSync(legacy) || existsSync(target)) return false
  await mkdir(stateDir, { recursive: true })
  await copyFile(legacy, target, fsConstants.COPYFILE_EXCL)
  try { await restrictPrivateKeyAcl(target) }
  catch (error) {
    await rm(target, { force: true }).catch(() => undefined)
    throw error
  }
  return true
}

async function readOrCreateAccountKey(stateDir: string, legacyStateDir?: string): Promise<Buffer> {
  const path = join(stateDir, 'acme-account.key')
  try {
    const key = await readFile(path)
    await restrictPrivateKeyAcl(path)
    return key
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (await migrateLegacyAccountKey(stateDir, legacyStateDir)) {
    const key = await readFile(path)
    await restrictPrivateKeyAcl(path)
    return key
  }
  await mkdir(stateDir, { recursive: true })
  const acme = await import('acme-client')
  const key = await acme.crypto.createPrivateKey()
  await writeFile(path, key, { mode: 0o600, flag: 'wx' })
  await restrictPrivateKeyAcl(path)
  return key
}

export async function restrictPrivateKeyAcl(path: string): Promise<void> {
  if (process.platform !== 'win32') return
  try {
    await execFileAsync('icacls', [
      path,
      '/inheritance:r',
      '/grant:r',
      `${userInfo().username}:(F)`,
      '*S-1-5-18:(F)',
      '*S-1-5-32-544:(F)'
    ], { windowsHide: true })
  } catch (error) {
    throw new Error(`无法收紧私钥文件权限：${error instanceof Error ? error.message : String(error)}`)
  }
}
