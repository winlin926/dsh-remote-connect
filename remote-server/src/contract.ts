import { z } from 'zod'

/** The complete capability whitelist of the node contract. */
export const CAPABILITY_VALUES = ['pairing', 'cache', 'official-ui', 'relay', 'turn'] as const

export type Capability = (typeof CAPABILITY_VALUES)[number]

export const NODE_KINDS = ['gateway', 'service'] as const

const capabilitySchema = z.enum(CAPABILITY_VALUES)

/** A Host id is the 43-character Base64URL S256 fingerprint of the Host SPKI key. */
export const HOST_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u
/** First 16 bytes of that digest, lowercase hex. */
export const FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/u
/** Base64URL alphabet and length only; the DER structure is validated by identity.ts. */
export const IDENTITY_KEY_PATTERN = /^[A-Za-z0-9_-]{40,120}$/u

const identityKeySchema = z.string().regex(
  IDENTITY_KEY_PATTERN,
  'Identity key must be a Base64URL-encoded SPKI DER public key.',
)

/**
 * The identity every v2 node publishes: a stable Ed25519 public key plus the
 * digest-derived id and fingerprint. One node has exactly one identity, no
 * matter how many Hosts register on it.
 */
export const nodePublicIdentitySchema = z.object({
  id: z.string().regex(HOST_ID_PATTERN),
  fingerprint: z.string().regex(FINGERPRINT_PATTERN),
  publicKey: identityKeySchema,
}).strict()

export type NodePublicIdentity = z.infer<typeof nodePublicIdentitySchema>

/**
 * The unified v2 node descriptor returned by `/.well-known/dsh-remote`.
 * `kind` is fixed to `service` for this deployment, but the schema accepts both
 * kinds so tests can prove that a wrong `kind`/`protocol` is rejected. Service
 * descriptors carry no flat `hostId`/`fingerprint`: those belong to a Host, and
 * one service node may host many of them.
 */
export const nodeDescriptorSchema = z.object({
  protocol: z.literal(2),
  kind: z.enum(NODE_KINDS),
  name: z.string().min(1).max(64),
  version: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/u),
  capabilities: z.array(capabilitySchema).min(1).max(CAPABILITY_VALUES.length).refine(
    values => new Set(values).size === values.length,
    'Capabilities must be unique.',
  ).refine(values => values.includes('pairing'), 'The "pairing" capability is required.'),
  node: nodePublicIdentitySchema,
}).strict()

export type NodeDescriptor = z.infer<typeof nodeDescriptorSchema>

export function parseNodeDescriptor(value: unknown): NodeDescriptor {
  return nodeDescriptorSchema.parse(value)
}

/**
 * Persisted `node-identity.json`. The private key never leaves memory: this
 * file only holds the public half, so losing it changes the node fingerprint.
 */
export const nodeIdentitySchema = z.object({
  version: z.literal(1),
  algorithm: z.literal('ed25519'),
  publicKey: identityKeySchema,
  createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
}).strict()

export type NodeIdentityRecord = z.infer<typeof nodeIdentitySchema>

export const DEVICE_ID_PATTERN = /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu

const deviceIdSchema = z.string().regex(DEVICE_ID_PATTERN, 'Device ID must be a ULID or UUID.')
/**
 * A Host registers with `deviceId === hostId`, so its device id is either a
 * regular ULID/UUID (older clients) or the 43-character Base64URL Host id.
 */
const hostDeviceIdSchema = z.string().refine(
  value => DEVICE_ID_PATTERN.test(value) || HOST_ID_PATTERN.test(value),
  'Device ID must be a ULID, a UUID, or the 43-character Base64URL Host id.',
)
const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength
const deviceNameSchema = z.string().refine(value => {
  const length = utf8Length(value)
  return length >= 1 && length <= 128 && value.trim().length > 0
}, 'Device name must be 1-128 UTF-8 bytes of visible text.')
const platformSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/u)
const clientVersionSchema = z.string().refine(value => {
  const length = utf8Length(value)
  return length >= 1 && length <= 64
}, 'Client version must be 1-64 UTF-8 bytes.')

/**
 * Body of `POST /v1/hosts`. `identityKey` is Base64URL(SPKI DER) of the Host
 * public key — the same encoding as `host-identity.publicKey` in the Host
 * plugin (Ed25519 SPKI DER, 44 bytes / 59 characters).
 */
export const hostRegistrationSchema = z.object({
  deviceId: hostDeviceIdSchema,
  name: deviceNameSchema,
  identityKey: identityKeySchema,
  clientVersion: clientVersionSchema,
}).strict()

export type HostRegistration = z.infer<typeof hostRegistrationSchema>

/**
 * Body of `POST /v1/pairings`. The Host normally supplies the ticket (32 random
 * bytes, base64url); when omitted the node generates one and returns it.
 */
export const createPairingSchema = z.object({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).optional(),
  expiresAt: z.number().int().positive().safe().optional(),
}).strict()

/** Client descriptor inside `POST /v1/pairings/claim`. */
export const pairingClientSchema = z.object({
  deviceId: deviceIdSchema,
  name: deviceNameSchema,
  platform: platformSchema,
  identityKey: identityKeySchema,
}).strict()

export type PairingClient = z.infer<typeof pairingClientSchema>

export const claimPairingSchema = z.object({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  client: pairingClientSchema,
}).strict()

export type ClaimPairing = z.infer<typeof claimPairingSchema>

/** Names a Host may push to `/v1/assets` (path length is bounded separately). */
export const ASSET_REVISION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u
