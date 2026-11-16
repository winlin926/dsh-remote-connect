import { z } from 'zod'

/** The complete capability whitelist of the node contract. */
export const CAPABILITY_VALUES = ['pairing', 'cache', 'official-ui', 'relay', 'turn'] as const

export type Capability = (typeof CAPABILITY_VALUES)[number]

export const NODE_KINDS = ['gateway', 'service'] as const

const capabilitySchema = z.enum(CAPABILITY_VALUES)

/**
 * The unified node descriptor returned by `/.well-known/dsh-remote`.
 * `kind` is fixed to `service` for this deployment, but the schema accepts both
 * kinds so tests can prove that a wrong `kind`/`protocol` is rejected.
 */
export const nodeDescriptorSchema = z.object({
  protocol: z.literal(1),
  kind: z.enum(NODE_KINDS),
  name: z.string().min(1).max(64),
  version: z.string().min(1).max(64),
  capabilities: z.array(capabilitySchema).min(1).max(CAPABILITY_VALUES.length).refine(
    values => new Set(values).size === values.length,
    'Capabilities must be unique.',
  ).refine(values => values.includes('pairing'), 'The "pairing" capability is required.'),
  hostId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  fingerprint: z.string().regex(/^[0-9a-f]{32}$/u),
}).strict()

export type NodeDescriptor = z.infer<typeof nodeDescriptorSchema>

export function parseNodeDescriptor(value: unknown): NodeDescriptor {
  return nodeDescriptorSchema.parse(value)
}

export const DEVICE_ID_PATTERN = /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu
export const IDENTITY_KEY_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u

const deviceIdSchema = z.string().regex(DEVICE_ID_PATTERN, 'Device ID must be a ULID or UUID.')
const identityKeySchema = z.string().regex(IDENTITY_KEY_PATTERN, 'Identity key must be a raw 32-byte Base64URL value.')
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

/** Body of `POST /v1/hosts` — identityKey is the Host's raw X25519 public key. */
export const hostRegistrationSchema = z.object({
  deviceId: deviceIdSchema,
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
