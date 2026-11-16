import { createHash, createPublicKey, timingSafeEqual } from 'node:crypto'
import { ApiError } from './errors.js'

/** Version prefix of the desktop<->server pairing transcript; bump only with a format change. */
const PAIRING_TRANSCRIPT_VERSION = 1

/** Canonical unpadded Base64URL alphabet. */
const BASE64URL = /^[A-Za-z0-9_-]+$/u

export function sha256(input: string | Uint8Array): Buffer {
  return createHash('sha256').update(input).digest()
}

export function sha256Hex(input: string | Uint8Array): string {
  return sha256(input).toString('hex')
}

export function toBase64Url(input: Uint8Array): string {
  return Buffer.from(input).toString('base64url')
}

/** True only for canonical (unpadded, right-alphabet, re-encodable) Base64URL. */
export function isCanonicalBase64Url(value: string): boolean {
  if (value.length === 0 || !BASE64URL.test(value)) return false
  return Buffer.from(value, 'base64url').toString('base64url') === value
}

/** Decode canonical Base64URL, enforcing an exact byte length; null on any mismatch. */
export function decodeCanonicalBase64Url(value: string, expectedBytes?: number): Buffer | null {
  if (!isCanonicalBase64Url(value)) return null
  const decoded = Buffer.from(value, 'base64url')
  if (expectedBytes !== undefined && decoded.byteLength !== expectedBytes) return null
  return decoded
}

/** Generate an opaque bearer token (32 random bytes, Base64URL) plus its storage hash. */
export function createToken(bytes = 32): { token: string; hash: string } {
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))
  return { token, hash: hashToken(token) }
}

export function hashToken(token: string): string {
  return sha256Hex(token)
}

/** Constant-time comparison of two hex digests. */
export function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length || left.length === 0) return false
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  if (a.byteLength !== b.byteLength || a.byteLength === 0) return false
  return timingSafeEqual(a, b)
}

/** Constant-time comparison of two opaque strings by their SHA-256 digests. */
export function constantTimeStringEqual(left: string, right: string): boolean {
  return timingSafeEqual(sha256(left), sha256(right))
}

export interface HostIdentity {
  /** Base64URL(SHA-256(SPKI DER)), always 43 characters. */
  hostId: string
  /** First 16 bytes of the same digest, lowercase hex, always 32 characters. */
  fingerprint: string
}

/**
 * Decode and validate an identity key: Base64URL(SPKI DER) of a public key.
 * This is the same encoding the Host publishes as `host-identity.publicKey`
 * (Ed25519 SPKI DER), so no key type is guessed and no prefix is prepended.
 * Returns the DER bytes, or null when the value is not a valid SPKI key.
 */
export function decodeIdentityKey(identityKey: string): Buffer | null {
  const der = decodeCanonicalBase64Url(identityKey)
  if (der === null) return null
  try {
    createPublicKey({ key: der, format: 'der', type: 'spki' })
  } catch {
    return null
  }
  return der
}

/**
 * Derive the node-visible identity of a Host from its SPKI DER public key,
 * exactly as `src/host-identity.ts` does: one sha256 digest over the DER bytes.
 * Both the Host and the phone publish `identityKey` in this encoding, and the
 * same string is fed into the pairing-code transcript.
 */
export function deriveHostIdentity(identityKey: string): HostIdentity {
  const der = decodeIdentityKey(identityKey)
  if (der === null) {
    throw ApiError.badRequest('INVALID_IDENTITY_KEY', 'identityKey must be a Base64URL-encoded SPKI DER public key.')
  }
  const digest = sha256(der)
  return {
    hostId: toBase64Url(digest),
    fingerprint: digest.subarray(0, 16).toString('hex'),
  }
}

/**
 * Eight-digit comparison code shown by both ends during pairing. This mirrors
 * the Host/browser implementation exactly (same transcript and truncation) so
 * all three parties display the same number. It is display-only, never a
 * credential, and is never persisted.
 */
export function pairingVerificationCode(ticket: string, hostIdentityKey: string, clientIdentityKey: string): string {
  const transcript = new TextEncoder().encode(
    `DSH-REMOTE-PAIR\0v=${PAIRING_TRANSCRIPT_VERSION}\0${ticket}\0${hostIdentityKey}\0${clientIdentityKey}`,
  )
  const digest = sha256(transcript)
  const value = digest.readUInt32BE(0)
  return String(value % 100_000_000).padStart(8, '0')
}

/** Correlation id for a request/connection; never derived from user input. */
export function newRequestId(): string {
  return crypto.randomUUID()
}
