import { createHash, timingSafeEqual } from 'node:crypto'
import { PROTOCOL_VERSION } from './protocol.js'

/** Canonical unpadded Base64URL alphabet. */
const BASE64URL = /^[A-Za-z0-9_-]+$/u

/** X25519 SubjectPublicKeyInfo prefix (RFC 8410) wrapped around a raw 32-byte key. */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

/** Advertised before the first Host registers: format-valid but clearly empty. */
export const EMPTY_HOST_ID = 'A'.repeat(43)
export const EMPTY_FINGERPRINT = '0'.repeat(32)

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
  /** Base64URL(SHA-256(X25519 SPKI DER)), always 43 characters. */
  hostId: string
  /** First 16 bytes of the same digest, lowercase hex, always 32 characters. */
  fingerprint: string
}

/**
 * Derive the node-visible identity of a Host from its raw X25519 public key.
 * The exact byte layout is part of the node contract; the same derivation is
 * used by the Host and browser. `identityKey` is expected to be a canonical
 * 43-character Base64URL string.
 */
export function deriveHostIdentity(identityKey: string): HostIdentity {
  const raw = decodeCanonicalBase64Url(identityKey, 32)
  if (!raw) throw new TypeError('Host identity key must be a canonical 32-byte Base64URL value.')
  const der = Buffer.concat([X25519_SPKI_PREFIX, raw])
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
    `DSH-REMOTE-PAIR\0v=${PROTOCOL_VERSION}\0${ticket}\0${hostIdentityKey}\0${clientIdentityKey}`,
  )
  const digest = sha256(transcript)
  const value = digest.readUInt32BE(0)
  return String(value % 100_000_000).padStart(8, '0')
}

/** Correlation id for a request/connection; never derived from user input. */
export function newRequestId(): string {
  return crypto.randomUUID()
}
