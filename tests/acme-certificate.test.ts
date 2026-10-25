import { afterEach, describe, expect, it } from 'vitest'
import { X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createCertificateManager,
  deployCertificate,
  migrateLegacyAccountKey,
  readDeployedCertificate,
  restrictPrivateKeyAcl
} from '../src/acme-certificate.js'

const SELF_SIGNED = readFileSync(fileURLToPath(new URL('./fixtures/example.test.crt', import.meta.url)), 'utf8')
const ISSUED = readFileSync(fileURLToPath(new URL('./fixtures/issued.test.crt', import.meta.url)), 'utf8')
const expiryOf = (pem: string): number => Date.parse(new X509Certificate(pem).validTo)
const directories: string[] = []

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-rc-acme-'))
  directories.push(directory)
  const deployDir = join(directory, 'deploy')
  mkdirSync(deployDir, { recursive: true })
  return { deployDir, stateDir: join(directory, 'acme'), challengeDir: join(directory, 'acme', 'challenge') }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('deployed certificate inspection', () => {
  it('recognises the frpc self-signed placeholder', async () => {
    const paths = workspace(), path = join(paths.deployDir, 'dsh.example.com.crt')
    writeFileSync(path, SELF_SIGNED)
    expect(await readDeployedCertificate(path)).toEqual({ expiresAt: expiryOf(SELF_SIGNED), selfSigned: true })
  })

  it('recognises a CA-issued certificate and missing files', async () => {
    const paths = workspace(), path = join(paths.deployDir, 'dsh.example.com.crt')
    writeFileSync(path, ISSUED)
    expect(await readDeployedCertificate(path)).toEqual({ expiresAt: expiryOf(ISSUED), selfSigned: false })
    expect(await readDeployedCertificate(join(paths.deployDir, 'missing.crt'))).toBeUndefined()
  })
})

describe('certificate manager', () => {
  it('reports no domain until one is configured', async () => {
    const paths = workspace(), manager = createCertificateManager({ ...paths, domain: () => undefined })
    const status = await manager.status()
    expect(status).toMatchObject({ selfSigned: false, pending: false, restartRequired: false })
    expect(status.domain).toBeUndefined()
  })

  it('replaces a self-signed placeholder once and reports that frpc may need a reload', async () => {
    const paths = workspace()
    writeFileSync(join(paths.deployDir, 'dsh.example.com.crt'), SELF_SIGNED)
    let issued = 0
    const withCounter = createCertificateManager({
      ...paths,
      domain: () => 'dsh.example.com',
      issue: async () => { issued++; return { certificate: ISSUED, key: 'PRIVATE KEY' } }
    })
    const status = await withCounter.ensure()
    expect(issued).toBe(1)
    expect(status.selfSigned).toBe(false)
    expect(status.restartRequired).toBe(true)
    expect(readFileSync(join(paths.deployDir, 'dsh.example.com.key'), 'utf8')).toBe('PRIVATE KEY')
    await withCounter.ensure()
    expect(issued).toBe(1)
  })

  it('renews inside the thirty-day window and supports forced renewal', async () => {
    const paths = workspace()
    writeFileSync(join(paths.deployDir, 'dsh.example.com.crt'), ISSUED)
    let issued = 0
    const manager = createCertificateManager({
      ...paths,
      domain: () => 'dsh.example.com',
      now: () => expiryOf(ISSUED) - 10 * 24 * 60 * 60 * 1000,
      issue: async () => { issued++; return { certificate: ISSUED, key: 'PRIVATE KEY' } }
    })
    await manager.ensure()
    await manager.ensure()
    expect(issued).toBe(2)
    const fresh = createCertificateManager({
      ...paths,
      domain: () => 'dsh.example.com',
      now: () => expiryOf(ISSUED) - 60 * 24 * 60 * 60 * 1000,
      issue: async () => { issued++; return { certificate: ISSUED, key: 'PRIVATE KEY' } }
    })
    await fresh.ensure(true)
    expect(issued).toBe(3)
  })

  it('keeps errors with their domain and clears pending after failure', async () => {
    const paths = workspace()
    let domain = 'a.example.com'
    const manager = createCertificateManager({
      ...paths,
      domain: () => domain,
      issue: async () => { throw new Error(`rate limited for ${domain}`) }
    })
    await expect(manager.ensure()).rejects.toThrow('rate limited for a.example.com')
    expect(await manager.status()).toMatchObject({ error: 'rate limited for a.example.com', pending: false })
    domain = 'b.example.com'
    expect((await manager.status()).error).toBeUndefined()
  })

  it('does not deploy a certificate after the domain changes during issuance', async () => {
    const paths = workspace()
    let domain = 'a.example.com'
    const manager = createCertificateManager({
      ...paths,
      domain: () => domain,
      issue: async () => {
        domain = 'b.example.com'
        return { certificate: ISSUED, key: 'PRIVATE KEY' }
      }
    })
    await expect(manager.ensure()).rejects.toThrow('公网域名已变更')
    expect(existsSync(join(paths.deployDir, 'a.example.com.crt'))).toBe(false)
    expect(existsSync(join(paths.deployDir, 'b.example.com.crt'))).toBe(false)
  })

  it('does not deploy after the listener closes during issuance', async () => {
    const paths = workspace()
    let listening = true
    const manager = createCertificateManager({
      ...paths,
      domain: () => 'dsh.example.com',
      beforeIssue: async () => { if (!listening) throw new Error('公网监听已停止') },
      issue: async () => {
        listening = false
        return { certificate: ISSUED, key: 'PRIVATE KEY' }
      }
    })
    await expect(manager.ensure()).rejects.toThrow('公网监听已停止')
    expect(existsSync(join(paths.deployDir, 'dsh.example.com.crt'))).toBe(false)
  })
})

describe('certificate deployment and migration', () => {
  it('restores the previous certificate and key when the second replacement fails', async () => {
    const paths = workspace()
    const certificatePath = join(paths.deployDir, 'dsh.example.com.crt')
    const keyPath = join(paths.deployDir, 'dsh.example.com.key')
    writeFileSync(certificatePath, SELF_SIGNED)
    writeFileSync(keyPath, 'OLD PRIVATE KEY')
    await expect(deployCertificate(
      { certificatePath, keyPath },
      { certificate: ISSUED, key: 'NEW PRIVATE KEY' },
      async (source, destination) => {
        if (destination === keyPath) {
          const { rm } = await import('node:fs/promises')
          await rm(destination, { force: true })
          throw new Error('injected key replacement failure')
        }
        await rename(source, destination)
      }
    )).rejects.toThrow('injected key replacement failure')
    expect(readFileSync(certificatePath, 'utf8')).toBe(SELF_SIGNED)
    expect(readFileSync(keyPath, 'utf8')).toBe('OLD PRIVATE KEY')
  })

  it('migrates the old ACME account without rewriting the legacy key', async () => {
    const paths = workspace(), legacyStateDir = join(paths.stateDir, 'legacy')
    mkdirSync(legacyStateDir, { recursive: true })
    const legacyKey = join(legacyStateDir, 'acme-account.key')
    writeFileSync(legacyKey, 'LEGACY ACCOUNT KEY')
    expect(await migrateLegacyAccountKey(paths.stateDir, legacyStateDir)).toBe(true)
    expect(readFileSync(join(paths.stateDir, 'acme-account.key'), 'utf8')).toBe('LEGACY ACCOUNT KEY')
    expect(readFileSync(legacyKey, 'utf8')).toBe('LEGACY ACCOUNT KEY')
    expect(await migrateLegacyAccountKey(paths.stateDir, legacyStateDir)).toBe(false)
  })
})

describe('private key ACL', () => {
  it('removes inherited access for other local accounts on Windows', async () => {
    if (process.platform !== 'win32') return
    const paths = workspace(), keyPath = join(paths.stateDir, 'account.key')
    mkdirSync(paths.stateDir, { recursive: true })
    writeFileSync(keyPath, 'secret')
    await restrictPrivateKeyAcl(keyPath)
    const { execFileSync } = await import('node:child_process')
    const sids = execFileSync('pwsh', [
      '-NoProfile',
      '-Command',
      `(Get-Acl '${keyPath}').Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }`
    ], { encoding: 'utf8' })
    expect(sids).not.toContain('S-1-5-11')
    expect(sids).not.toContain('S-1-1-0')
    expect(sids).toContain('S-1-5-18')
  })
})
