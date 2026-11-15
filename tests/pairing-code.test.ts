import { describe, expect, it } from 'vitest'
import { generateKeyPair } from '../src/remote/vendor/crypto/index.js'
import { pairingVerificationCode } from '../src/remote/pairing-code.js'

describe('pairingVerificationCode', () => {
  it('matches independently on the Host and browser and binds each pairing identity', () => {
    const host = generateKeyPair(new Uint8Array(32).fill(1))
    const client = generateKeyPair(new Uint8Array(32).fill(2))
    const otherClient = generateKeyPair(new Uint8Array(32).fill(3))
    const ticket = Buffer.alloc(32, 4).toString('base64url')
    const code = pairingVerificationCode(ticket, host.publicKey, client.publicKey)
    expect(code).toMatch(/^\d{8}$/)
    expect(pairingVerificationCode(ticket, host.publicKey, client.publicKey)).toBe(code)
    expect(pairingVerificationCode(ticket, host.publicKey, otherClient.publicKey)).not.toBe(code)
    expect(pairingVerificationCode(Buffer.alloc(32, 5).toString('base64url'), host.publicKey, client.publicKey)).not.toBe(code)
    expect(() => pairingVerificationCode(ticket, 'bad', client.publicKey)).toThrow('Pairing code inputs are invalid.')
  })
})
