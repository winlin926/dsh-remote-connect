import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** The file both the gateway and a local remote-server read to present one stable Host identity. */
export const HOST_IDENTITY_FILE = 'host-identity.json'
const IDENTITY_VERSION = 1
const IDENTITY_ALGORITHM = 'ed25519'
const FINGERPRINT_PATTERN = /^[a-f0-9]{32}$/

interface StoredIdentity { version: 1; algorithm: 'ed25519'; publicKey: string; privateKey: string; createdAt: string }

/** The public half of a Host identity: two encodings of one sha256 digest over the Ed25519 SPKI DER. */
export interface HostKeyIdentity {
  /** base64url(sha256(SPKI DER)), exactly 43 characters. */
  hostId: string
  /** The first 16 digest bytes as lowercase hex, exactly 32 characters. */
  fingerprint: string
  /** The fingerprint in eight 4-character groups, `A1B2-C3D4-...`, for a person to compare. */
  fingerprintGroups: string
}

export interface HostIdentity extends HostKeyIdentity {
  /** SPKI DER, base64url; public and safe to publish. */
  publicKey: string
  /** Ed25519 private key. It never leaves this computer and is never serialized into a response. */
  privateKey: KeyObject
}

/** A person compares the grouped form character by character; the other two encodings are for machines. */
export function fingerprintGroupsOf(fingerprint: string): string {
  if (!FINGERPRINT_PATTERN.test(fingerprint)) throw new Error('指纹必须是 32 位小写十六进制。')
  return fingerprint.toUpperCase().match(/.{4}/g)!.join('-')
}

/** Derive the published identity from a public key: one digest, three encodings, no key material stored twice. */
export function identityOfPublicKey(publicKey: Buffer): HostKeyIdentity {
  const digest = createHash('sha256').update(publicKey).digest()
  const fingerprint = digest.subarray(0, 16).toString('hex')
  return { hostId: digest.toString('base64url'), fingerprint, fingerprintGroups: fingerprintGroupsOf(fingerprint) }
}

function corrupt(file: string): Error {
  // An identity that silently changes would orphan every pairing and cache entry, so a damaged
  // file is a hard error and never a reason to generate a fresh identity behind the user's back.
  return new Error(`主机身份文件已损坏：${file}。为避免主机身份变化，不会自动重建；请备份后删除该文件再重试。`)
}

function parseIdentity(file: string, text: string): HostIdentity {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw corrupt(file) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt(file)
  const stored = value as Record<string, unknown>
  if (stored.version !== IDENTITY_VERSION || stored.algorithm !== IDENTITY_ALGORITHM || typeof stored.publicKey !== 'string' || typeof stored.privateKey !== 'string' || typeof stored.createdAt !== 'string') throw corrupt(file)
  let privateKey: KeyObject
  let publicDer: Buffer
  try {
    privateKey = createPrivateKey({ key: Buffer.from(stored.privateKey, 'base64url'), format: 'der', type: 'pkcs8' })
    if (privateKey.asymmetricKeyType !== IDENTITY_ALGORITHM) throw new Error('算法不一致。')
    publicDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  } catch { throw corrupt(file) }
  // The stored public key must be the one this private key actually produces; a partial copy is corruption.
  if (publicDer.toString('base64url') !== stored.publicKey) throw corrupt(file)
  return { ...identityOfPublicKey(publicDer), publicKey: stored.publicKey, privateKey }
}

function createIdentity(): { identity: HostIdentity; stored: StoredIdentity } {
  const pair = generateKeyPairSync(IDENTITY_ALGORITHM)
  const privateDer = pair.privateKey.export({ format: 'der', type: 'pkcs8' })
  const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' })
  const publicKey = publicDer.toString('base64url')
  return {
    identity: { ...identityOfPublicKey(publicDer), publicKey, privateKey: pair.privateKey },
    stored: { version: IDENTITY_VERSION, algorithm: IDENTITY_ALGORITHM, publicKey, privateKey: privateDer.toString('base64url'), createdAt: new Date().toISOString() },
  }
}

async function saveIdentity(file: string, stored: StoredIdentity): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    // The key file is written beside its destination and renamed, so a crash never leaves a truncated key.
    await writeFile(temporary, JSON.stringify(stored), { mode: 0o600 })
    await rename(temporary, file)
  } catch (failure) { await rm(temporary, { force: true }); throw failure }
}

/** Load the Host identity, creating it on first use. Repeated loads of one file return the same hostId. */
export async function loadHostIdentity(file: string): Promise<HostIdentity> {
  let text: string
  try { text = await readFile(file, 'utf8') } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`主机身份文件无法读取：${file}。`)
    // Two DSH processes sharing one profile would race here; the rename is atomic and one identity wins.
    const created = createIdentity()
    await saveIdentity(file, created.stored)
    return created.identity
  }
  // A key copied in with loose permissions is still the same key; reading it is a safe point to tighten mode.
  await chmod(file, 0o600).catch(() => undefined)
  return parseIdentity(file, text)
}
