import { sha256 } from '@noble/hashes/sha256'
import { fromBase64Url, toBase64Url } from './vendor/crypto/index.js'

export function pairingVerificationCode(ticket: string, hostIdentityKey: string, clientIdentityKey: string): string {
  const hostKey = fromBase64Url(hostIdentityKey)
  const clientKey = fromBase64Url(clientIdentityKey)
  if (hostKey.byteLength !== 32 || toBase64Url(hostKey) !== hostIdentityKey
    || clientKey.byteLength !== 32 || toBase64Url(clientKey) !== clientIdentityKey
    || !/^[A-Za-z0-9_-]{43}$/.test(ticket) || toBase64Url(fromBase64Url(ticket)) !== ticket) {
    throw new TypeError('Pairing code inputs are invalid.')
  }
  const transcript = new TextEncoder().encode(`DSH-REMOTE-PAIR\0v=1\0${ticket}\0${hostIdentityKey}\0${clientIdentityKey}`)
  const digest = sha256(transcript)
  const value = new DataView(digest.buffer, digest.byteOffset, digest.byteLength).getUint32(0)
  return String(value % 100_000_000).padStart(8, '0')
}
