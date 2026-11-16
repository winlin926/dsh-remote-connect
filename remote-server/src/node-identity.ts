import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nodeIdentitySchema } from './contract.js'
import { decodeIdentityKey, deriveHostIdentity, toBase64Url } from './identity.js'

/** File that carries the public half of the node identity inside `DATA_DIR`. */
export const NODE_IDENTITY_FILE = 'node-identity.json'

/** Stable, persisted node identity; shared by every Host registered on the node. */
export interface NodeIdentity {
  /** Base64URL(SHA-256(SPKI DER)), 43 characters. */
  readonly nodeId: string
  /** First 16 bytes of the same digest, lowercase hex, 32 characters. */
  readonly fingerprint: string
  /** Base64URL(SPKI DER) of the Ed25519 public key. */
  readonly publicKey: string
  /** ISO 8601 timestamp of the first creation. */
  readonly createdAt: string
  /** Absolute path of the persisted identity document. */
  readonly file: string
}

const DAMAGED = '节点身份文件已损坏'

export function nodeIdentityPath(dataDir: string): string {
  return join(dataDir, NODE_IDENTITY_FILE)
}

function damaged(file: string, reason: string): Error {
  return new Error(`${DAMAGED}：${file}（${reason}）`)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Turn a validated record plus its public key into the runtime identity. */
function identityFrom(record: { publicKey: string; createdAt: string }, file: string): NodeIdentity {
  const identity = deriveHostIdentity(record.publicKey)
  return {
    nodeId: identity.hostId,
    fingerprint: identity.fingerprint,
    publicKey: record.publicKey,
    createdAt: record.createdAt,
    file,
  }
}

/**
 * Validate an existing `node-identity.json`. Corruption is never repaired
 * silently: changing the fingerprint would silently invalidate every node
 * record and cache that clients already trusted.
 */
function loadIdentity(file: string): NodeIdentity {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw damaged(file, `无法读取（${describe(error)}）`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw damaged(file, `JSON 无法解析（${describe(error)}）`)
  }
  const parsed = nodeIdentitySchema.safeParse(raw)
  if (!parsed.success) {
    throw damaged(file, parsed.error.issues[0]?.message ?? '字段不合法')
  }
  if (decodeIdentityKey(parsed.data.publicKey) === null) {
    throw damaged(file, 'publicKey 不是合法的 SPKI DER 公钥')
  }
  return identityFrom(parsed.data, file)
}

/**
 * Load the node identity from `DATA_DIR`, generating and persisting a fresh
 * Ed25519 keypair when the file does not exist yet. The private key stays in
 * this process only; the file is a public identity document written atomically
 * (temporary file + rename, mode 0600).
 */
export function loadOrCreateNodeIdentity(
  dataDir: string,
  now: () => Date = () => new Date(),
): NodeIdentity {
  const file = nodeIdentityPath(dataDir)
  mkdirSync(dataDir, { recursive: true })
  if (existsSync(file)) return loadIdentity(file)

  const pair = generateKeyPairSync('ed25519')
  const publicKey = toBase64Url(pair.publicKey.export({ format: 'der', type: 'spki' }))
  const record = {
    version: 1,
    algorithm: 'ed25519',
    publicKey,
    createdAt: now().toISOString(),
  }
  const validated = nodeIdentitySchema.safeParse(record)
  if (!validated.success) {
    throw new Error(`节点身份无法生成：${validated.error.issues[0]?.message ?? '字段不合法'}`)
  }
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(validated.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw new Error(`节点身份文件写入失败：${file}（${describe(error)}）`)
  }
  return identityFrom(validated.data, file)
}
