import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  FINGERPRINT_PATTERN, HOST_ID_PATTERN, NODE_VERSION_PATTERN, PUBLIC_NODE_PROTOCOL,
  isPublicNodeCapability, isPublicNodeKind, isPublicNodeName, normalizeNodeOrigin,
  type PublicNodeCapability, type PublicNodeKind,
} from './public-node.js'
import { readPublicUrl } from './public-url-settings.js'

export const PUBLIC_NODES_FILE = 'public-nodes.json'
export const PUBLIC_NODES_VERSION = 1

/** One node the user can switch between. Unprobed candidates carry null in every field a probe would fill. */
export interface PublicNodeRecord {
  id: string
  /** Normalized HTTPS origin; the one address the user typed. */
  url: string
  kind: PublicNodeKind | null
  name: string | null
  version: string | null
  protocol: number | null
  capabilities: PublicNodeCapability[] | null
  hostId: string | null
  fingerprint: string | null
  addedAt: number
  lastCheckAt: number | null
  lastCheckOk: boolean
  lastCheckError: string | null
  /** True until a discovery probe has filled the fields above; a migrated legacy address stays pending. */
  pending: boolean
}

export interface PublicNodesFile { version: 1; current: string | null; nodes: PublicNodeRecord[] }

export interface PublicNodeConfigOptions {
  /** `public-nodes.json` in the plugin storage directory. */
  file: string
  /** `public-url.json` from earlier releases; only read when the node list file does not exist yet. */
  legacyFile?: string
  now?: () => number
}

export interface PublicNodeInput {
  url: string
  kind?: PublicNodeKind | null
  name?: string | null
  version?: string | null
  protocol?: number | null
  capabilities?: PublicNodeCapability[] | null
  hostId?: string | null
  fingerprint?: string | null
  /** Defaults to true unless probe fields were supplied. */
  pending?: boolean
}

/** All fields a probe result may fill in, plus the check outcome; `url` may be corrected for an existing node. */
export interface PublicNodePatch {
  url?: string
  kind?: PublicNodeKind | null
  name?: string | null
  version?: string | null
  protocol?: number | null
  capabilities?: PublicNodeCapability[] | null
  hostId?: string | null
  fingerprint?: string | null
  lastCheckAt?: number | null
  lastCheckOk?: boolean
  lastCheckError?: string | null
  pending?: boolean
}

/** What the caller must purge from its cache index after a removal; `hostId` is unknown for a never-probed node. */
export interface RemovedPublicNode { origin: string; hostId: string | null }

/** Validates and normalizes one record; null means the shape is not a node record at all. */
function recordOf(value: unknown): PublicNodeRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || row.id.length === 0 || row.id.length > 64) return null
  const url = typeof row.url === 'string' ? normalizeNodeOrigin(row.url) : null
  if (!url) return null
  const kind: PublicNodeKind | null | undefined = row.kind === null || row.kind === undefined ? null : isPublicNodeKind(row.kind) ? row.kind : undefined
  const name: string | null | undefined = row.name === null || row.name === undefined ? null : isPublicNodeName(row.name) ? row.name : undefined
  const version: string | null | undefined = row.version === null || row.version === undefined ? null : typeof row.version === 'string' && NODE_VERSION_PATTERN.test(row.version) ? row.version : undefined
  const protocol: number | null | undefined = row.protocol === null || row.protocol === undefined ? null : row.protocol === PUBLIC_NODE_PROTOCOL ? PUBLIC_NODE_PROTOCOL : undefined
  const capabilities: PublicNodeCapability[] | null | undefined = row.capabilities === null || row.capabilities === undefined ? null : Array.isArray(row.capabilities) && row.capabilities.every(isPublicNodeCapability) ? [...row.capabilities] : undefined
  const hostId: string | null | undefined = row.hostId === null || row.hostId === undefined ? null : typeof row.hostId === 'string' && HOST_ID_PATTERN.test(row.hostId) ? row.hostId : undefined
  const fingerprint: string | null | undefined = row.fingerprint === null || row.fingerprint === undefined ? null : typeof row.fingerprint === 'string' && FINGERPRINT_PATTERN.test(row.fingerprint) ? row.fingerprint : undefined
  if (kind === undefined || name === undefined || version === undefined || protocol === undefined || capabilities === undefined || hostId === undefined || fingerprint === undefined) return null
  // A node that advertises capabilities must still be able to pair; only never-probed candidates carry null.
  if (capabilities !== null && !capabilities.includes('pairing')) return null
  if (typeof row.addedAt !== 'number' || !Number.isFinite(row.addedAt)) return null
  const lastCheckAt: number | null | undefined = row.lastCheckAt === null || row.lastCheckAt === undefined ? null : typeof row.lastCheckAt === 'number' && Number.isFinite(row.lastCheckAt) ? row.lastCheckAt : undefined
  const lastCheckOk: boolean | undefined = typeof row.lastCheckOk === 'boolean' ? row.lastCheckOk : undefined
  const lastCheckError: string | null | undefined = row.lastCheckError === null || row.lastCheckError === undefined ? null : typeof row.lastCheckError === 'string' ? row.lastCheckError : undefined
  const pending: boolean | undefined = typeof row.pending === 'boolean' ? row.pending : undefined
  if (lastCheckAt === undefined || lastCheckOk === undefined || lastCheckError === undefined || pending === undefined) return null
  return { id: row.id, url, kind, name, version, protocol, capabilities, hostId, fingerprint, addedAt: row.addedAt, lastCheckAt, lastCheckOk, lastCheckError, pending }
}

function fileOf(value: unknown): PublicNodesFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.version !== PUBLIC_NODES_VERSION || !Array.isArray(row.nodes)) return null
  const nodes: PublicNodeRecord[] = []
  const ids = new Set<string>()
  for (const item of row.nodes) {
    const record = recordOf(item)
    // Duplicate ids would make "which node is current" ambiguous; that is damage, not a preference.
    if (!record || ids.has(record.id)) return null
    ids.add(record.id); nodes.push(record)
  }
  if (row.current !== null && row.current !== undefined && typeof row.current !== 'string') return null
  const current = typeof row.current === 'string' && ids.has(row.current) ? row.current : null
  return { version: PUBLIC_NODES_VERSION, current, nodes }
}

/** The durable multi-node list. Every mutation rewrites the whole file atomically; nothing is patched in place. */
export class PublicNodeConfig {
  private readonly file: string
  private readonly legacyFile?: string
  private readonly now: () => number
  private state: PublicNodesFile
  constructor(options: PublicNodeConfigOptions) {
    this.file = options.file
    this.legacyFile = options.legacyFile
    this.now = options.now ?? Date.now
    this.state = this.load()
  }
  private corrupt(): Error {
    return new Error(`公网节点配置文件已损坏：${this.file}。请备份后修复或删除；不会静默丢弃已保存的节点。`)
  }
  private load(): PublicNodesFile {
    let text: string
    try { text = readFileSync(this.file, 'utf8') } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`公网节点配置文件无法读取：${this.file}。`)
      const migrated = this.migrate()
      if (!migrated) return { version: PUBLIC_NODES_VERSION, current: null, nodes: [] }
      const state: PublicNodesFile = { version: PUBLIC_NODES_VERSION, current: null, nodes: [migrated] }
      this.save(state)
      return state
    }
    let value: unknown
    try { value = JSON.parse(text) } catch { throw this.corrupt() }
    const state = fileOf(value)
    if (!state) throw this.corrupt()
    return state
  }
  /**
   * The old release stored one public address in `public-url.json`. That address becomes a pending
   * candidate, never the current node: it has not been probed, and the user must confirm it.
   * Migration runs only when the node list file does not exist, so deleting the last node is not
   * undone by the legacy address on the next load.
   */
  private migrate(): PublicNodeRecord | null {
    if (!this.legacyFile) return null
    const legacy = readPublicUrl(this.legacyFile)
    if (!legacy) return null
    const url = normalizeNodeOrigin(legacy)
    if (!url) return null
    return { id: randomUUID(), url, kind: null, name: null, version: null, protocol: null, capabilities: null, hostId: null, fingerprint: null, addedAt: this.now(), lastCheckAt: null, lastCheckOk: false, lastCheckError: null, pending: true }
  }
  private save(state: PublicNodesFile): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 })
      renameSync(temporary, this.file)
    } catch (failure) {
      if (existsSync(temporary)) unlinkSync(temporary)
      throw failure
    }
  }
  private commit(state: PublicNodesFile): void { this.save(state); this.state = state }
  get current(): string | null { return this.state.current }
  list(): PublicNodeRecord[] { return this.state.nodes.map(node => ({ ...node, capabilities: node.capabilities ? [...node.capabilities] : null })) }
  add(input: PublicNodeInput): PublicNodeRecord {
    // A record is only non-pending when a probe supplied everything a probe fills; anything less is a candidate.
    const probed = input.kind != null && input.name != null && input.version != null && input.protocol != null && input.capabilities != null && input.hostId != null && input.fingerprint != null
    const pending = input.pending ?? !probed
    const now = this.now()
    const record = recordOf({
      id: randomUUID(), url: input.url, kind: input.kind ?? null, name: input.name ?? null, version: input.version ?? null,
      protocol: input.protocol ?? null, capabilities: input.capabilities ?? null, hostId: input.hostId ?? null, fingerprint: input.fingerprint ?? null,
      addedAt: now, lastCheckAt: pending ? null : now, lastCheckOk: !pending, lastCheckError: null, pending,
    })
    if (!record) throw new Error('公网节点记录无效：请检查地址、类型、版本、能力或身份字段。')
    this.commit({ ...this.state, nodes: [...this.state.nodes, record] })
    return record
  }
  update(id: string, patch: PublicNodePatch): PublicNodeRecord {
    const index = this.state.nodes.findIndex(node => node.id === id)
    if (index < 0) throw new Error('公网节点不存在。')
    const merged = recordOf({ ...this.state.nodes[index], ...patch })
    if (!merged) throw new Error('公网节点记录无效：请检查地址、类型、版本、能力或身份字段。')
    const nodes = this.state.nodes.map((node, at) => at === index ? merged : node)
    this.commit({ ...this.state, nodes })
    return merged
  }
  /** Returns the cache identity to purge; removing the current node leaves the list with no current node. */
  remove(id: string): RemovedPublicNode | null {
    const node = this.state.nodes.find(row => row.id === id)
    if (!node) return null
    this.commit({ version: PUBLIC_NODES_VERSION, current: this.state.current === id ? null : this.state.current, nodes: this.state.nodes.filter(row => row.id !== id) })
    return { origin: node.url, hostId: node.hostId }
  }
  setCurrent(id: string | null): void {
    if (id !== null && !this.state.nodes.some(node => node.id === id)) throw new Error('公网节点不存在。')
    this.commit({ ...this.state, current: id })
  }
}
