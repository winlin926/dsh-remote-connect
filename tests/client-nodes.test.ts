import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WAYS,
  checkedAtLabel,
  command,
  nodeCheckStatus,
  nodeFingerprintGroups,
  nodeHost,
  nodeKindLabel,
  parsePublicNodeAddress,
  serviceStateLabel,
  sortPublicNodes,
  when,
} from '../src/client/index.js'
import type { PublicNode } from '../src/client/index.js'

const SOURCE = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
const FINGERPRINT = 'e5029063f54829c639dac06e7a3de8cd'
const makeNode = (overrides: Partial<PublicNode> = {}): PublicNode => ({
  id: 'node-1', url: 'https://node.example.com', kind: 'gateway', name: '节点一', version: '0.5.1', protocol: 1,
  capabilities: ['remote-control'], hostId: 'host-1', fingerprint: FINGERPRINT,
  addedAt: 1_700_000_000_000, lastCheckAt: 1_700_000_500_000, lastCheckOk: true, lastCheckError: null, pending: false,
  ...overrides,
})

describe('parsePublicNodeAddress', () => {
  it('rejects an empty draft before any manage call', () => {
    expect(parsePublicNodeAddress('')).toEqual({ ok: false, error: '公网节点地址不能为空。' })
    expect(parsePublicNodeAddress('   ')).toEqual({ ok: false, error: '公网节点地址不能为空。' })
  })

  it('requires a complete URL with a scheme', () => {
    expect(parsePublicNodeAddress('node.example.com')).toEqual({ ok: false, error: '公网节点地址格式无效，请填写完整的 https:// 地址。' })
    expect(parsePublicNodeAddress('https://')).toEqual({ ok: false, error: '公网节点地址格式无效，请填写完整的 https:// 地址。' })
  })

  it('rejects insecure, credentialed and path-bearing addresses with the Host wording', () => {
    expect(parsePublicNodeAddress('http://node.example.com')).toEqual({ ok: false, error: '公网节点必须使用 https:// 地址。' })
    expect(parsePublicNodeAddress('https://user:secret@node.example.com')).toEqual({ ok: false, error: '公网节点地址不能包含账号或密码。' })
    expect(parsePublicNodeAddress('https://node.example.com/panel')).toEqual({ ok: false, error: '公网节点地址只能是域名，不能带路径、查询参数或锚点。' })
    expect(parsePublicNodeAddress('https://node.example.com/?a=1')).toEqual({ ok: false, error: '公网节点地址只能是域名，不能带路径、查询参数或锚点。' })
    expect(parsePublicNodeAddress('https://node.example.com/#top')).toEqual({ ok: false, error: '公网节点地址只能是域名，不能带路径、查询参数或锚点。' })
  })

  it('normalizes a valid address to its origin, keeping a non-default port', () => {
    expect(parsePublicNodeAddress('https://node.example.com')).toEqual({ ok: true, url: 'https://node.example.com' })
    expect(parsePublicNodeAddress(' https://node.example.com/ ')).toEqual({ ok: true, url: 'https://node.example.com' })
    expect(parsePublicNodeAddress('https://node.example.com:8443')).toEqual({ ok: true, url: 'https://node.example.com:8443' })
  })
})

describe('nodeHost', () => {
  it('labels a node by host and port so two entries on one host stay distinguishable', () => {
    expect(nodeHost('https://node.example.com')).toBe('node.example.com')
    expect(nodeHost('https://node.example.com:8443')).toBe('node.example.com:8443')
    expect(nodeHost('not a url')).toBe('not a url')
  })
})

describe('nodeKindLabel', () => {
  it('maps the protocol kinds to the panel wording', () => {
    expect(nodeKindLabel('gateway')).toBe('隧道网关')
    expect(nodeKindLabel('service')).toBe('自托管服务')
    expect(nodeKindLabel(null)).toBe('待确认')
  })
})

describe('nodeFingerprintGroups', () => {
  it('formats 32 hex digits as eight upper-case groups of four', () => {
    expect(nodeFingerprintGroups(FINGERPRINT)).toBe('E502-9063-F548-29C6-39DA-C06E-7A3D-E8CD')
    expect(nodeFingerprintGroups('E502-9063-F548-29C6-39DA-C06E-7A3D-E8CD')).toBe('E502-9063-F548-29C6-39DA-C06E-7A3D-E8CD')
  })

  it('falls back without inventing groups', () => {
    expect(nodeFingerprintGroups(null)).toBe('尚未上报')
    expect(nodeFingerprintGroups('')).toBe('尚未上报')
    expect(nodeFingerprintGroups('not-a-fingerprint')).toBe('NOT-A-FINGERPRINT')
  })
})

describe('checkedAtLabel', () => {
  const now = 1_700_000_000_000

  it('describes a never-checked entry', () => {
    expect(checkedAtLabel(null, now)).toBe('尚未检测')
  })

  it('handles clock skew without a negative wording', () => {
    expect(checkedAtLabel(now, now)).toBe('刚刚')
    expect(checkedAtLabel(now + 5_000, now)).toBe('刚刚')
  })

  it('steps through relative units at the exact boundaries', () => {
    expect(checkedAtLabel(now - 59_999, now)).toBe('刚刚')
    expect(checkedAtLabel(now - 60_000, now)).toBe('1 分钟前')
    expect(checkedAtLabel(now - 59 * 60_000, now)).toBe('59 分钟前')
    expect(checkedAtLabel(now - 60 * 60_000, now)).toBe('1 小时前')
    expect(checkedAtLabel(now - 23 * 3_600_000, now)).toBe('23 小时前')
    expect(checkedAtLabel(now - 24 * 3_600_000, now)).toBe('1 天前')
    expect(checkedAtLabel(now - 7 * 86_400_000 + 1, now)).toBe('6 天前')
  })

  it('falls back to the panel absolute format after a week', () => {
    const at = now - 7 * 86_400_000
    expect(checkedAtLabel(at, now)).toBe(when(at))
  })
})

describe('nodeCheckStatus', () => {
  it('reports pending, never checked, healthy and failed probes', () => {
    expect(nodeCheckStatus(makeNode({ pending: true }))).toEqual({ label: '待检测确认', tone: 'warn' })
    expect(nodeCheckStatus(makeNode({ lastCheckAt: null, lastCheckOk: false }))).toEqual({ label: '尚未检测', tone: 'neutral' })
    expect(nodeCheckStatus(makeNode())).toEqual({ label: '检测正常', tone: 'ok' })
    expect(nodeCheckStatus(makeNode({ lastCheckAt: 1_700_000_000_000, lastCheckOk: false }))).toEqual({ label: '检测失败', tone: 'danger' })
  })

  it('lets pending win over a stale check result', () => {
    expect(nodeCheckStatus(makeNode({ pending: true, lastCheckOk: false, lastCheckAt: 1 })).label).toBe('待检测确认')
  })
})

describe('sortPublicNodes', () => {
  it('puts the current node first, then entries awaiting confirmation', () => {
    const nodes = [
      makeNode({ id: 'checked-new', lastCheckAt: 900 }),
      makeNode({ id: 'current', lastCheckAt: 100 }),
      makeNode({ id: 'pending', pending: true, lastCheckAt: 950 }),
    ]
    expect(sortPublicNodes(nodes, 'current').map(node => node.id)).toEqual(['current', 'pending', 'checked-new'])
  })

  it('orders the remaining entries by most recent check, then by added time', () => {
    const nodes = [
      makeNode({ id: 'old', lastCheckAt: 100 }),
      makeNode({ id: 'never-a', lastCheckAt: null, addedAt: 10 }),
      makeNode({ id: 'new', lastCheckAt: 900 }),
      makeNode({ id: 'never-b', lastCheckAt: null, addedAt: 20 }),
    ]
    expect(sortPublicNodes(nodes, null).map(node => node.id)).toEqual(['new', 'old', 'never-b', 'never-a'])
  })

  it('keeps a deterministic order for equal entries and never mutates the input', () => {
    const nodes = [makeNode({ id: 'b', url: 'https://b.example.com' }), makeNode({ id: 'a', url: 'https://a.example.com' })]
    const sorted = sortPublicNodes(nodes, null)
    expect(sorted.map(node => node.id)).toEqual(['a', 'b'])
    expect(nodes.map(node => node.id)).toEqual(['b', 'a'])
    expect(sorted).not.toBe(nodes)
  })
})

describe('serviceStateLabel', () => {
  it('separates connected, connecting and failed states with the Host reason', () => {
    expect(serviceStateLabel({ connected: true })).toEqual({ label: '已连接', tone: 'ok', reason: '' })
    expect(serviceStateLabel({ connected: false })).toEqual({ label: '正在连接…', tone: 'warn', reason: '' })
    expect(serviceStateLabel({ connected: false, lastError: '节点身份校验失败。' })).toEqual({ label: '未连接', tone: 'danger', reason: '节点身份校验失败。' })
  })
})

describe('connection way copy', () => {
  it('renames the public way to 公网连接 and drops the old wording from the panel', () => {
    expect(WAYS.find(way => way.mode === 'public')?.name).toBe('公网连接')
    expect(SOURCE).not.toContain('任意网络')
  })
})

describe('node interactions use the documented manage actions', () => {
  it('wires every node control to its manage action', () => {
    for (const action of ['addPublicNode', 'checkPublicNode', 'setCurrentPublicNode', 'removePublicNode', 'approveServicePairing', 'rejectServicePairing']) {
      expect(SOURCE).toContain(action)
    }
  })
})

describe('command', () => {
  const transport = globalThis as unknown as { __DSH_TRANSPORT__?: { fetch?: typeof fetch } }
  const original = transport.__DSH_TRANSPORT__
  afterEach(() => { if (original === undefined) delete transport.__DSH_TRANSPORT__; else transport.__DSH_TRANSPORT__ = original })
  const respond = (body: unknown, status = 200) => {
    transport.__DSH_TRANSPORT__ = { fetch: async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) }
  }

  it('turns an HTTP 200 node failure into the thrown Chinese reason', async () => {
    respond({ ok: false, message: '该公网节点已存在。' })
    await expect(command({ action: 'addPublicNode', url: 'https://node.example.com' })).rejects.toThrow('该公网节点已存在。')
  })

  it('passes a successful payload through', async () => {
    respond({ ok: true, node: { id: 'node-1' } })
    const result = await command({ action: 'checkPublicNode', id: 'node-1' }) as unknown as { ok: boolean }
    expect(result.ok).toBe(true)
  })

  it('keeps the HTTP error wording', async () => {
    respond({ error: '当前没有连接自托管公网节点。' }, 400)
    await expect(command({ action: 'approveServicePairing', id: 'pair-1' })).rejects.toThrow('当前没有连接自托管公网节点。')
  })
})
