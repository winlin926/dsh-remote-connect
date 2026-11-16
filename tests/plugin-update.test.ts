import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  PluginUpdate,
  UPDATE_CACHE_MS,
  pickUpdate,
  resolvePluginManager,
  updateCard,
  type PluginManagerFace,
  type UpdateBundle,
  type UpdateVersionList,
} from '../src/client/plugin-update.js'

const NAME = '@winlin926/dsh-remote-connect'
const SOURCE = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
const bundle = (overrides: Partial<UpdateBundle> = {}): UpdateBundle => ({ name: NAME, installed: true, enabled: true, version: '0.6.2', update: 'registry', ...overrides })
const listed = (versions: Array<Record<string, unknown>>, installed = '0.6.2'): UpdateVersionList => ({
  status: 'listed', installed, registry: 'https://registry.npmjs.org', versions: versions.map(item => ({ version: '0.9.9', prerelease: false, bundle: true, ...item })) as never, omitted: 0,
} as UpdateVersionList)

interface Calls { bundles: number; versions: number; updates: Array<{ version: string; registry?: string; requestId: string }> }
function manager(overrides: {
  bundles?: () => Promise<unknown>
  versions?: () => Promise<unknown>
  update?: () => Promise<unknown>
} = {}): { face: PluginManagerFace; calls: Calls } {
  const calls: Calls = { bundles: 0, versions: 0, updates: [] }
  const face: PluginManagerFace = {
    async listBundles() { calls.bundles++; return (overrides.bundles ?? (async () => ({ ok: true, value: [bundle()] })))() as never },
    async listVersions() { calls.versions++; return (overrides.versions ?? (async () => ({ ok: true, value: listed([{ version: '0.7.0' }]) })))() as never },
    async updateBundle(_name, version, options) {
      calls.updates.push({ version, ...options })
      return (overrides.update ?? (async () => ({ ok: true, value: { from: '0.6.2', to: version, result: { changed: true, application: 'applied' } } })))() as never
    },
  }
  return { face, calls }
}
function store(face: PluginManagerFace | null, options: { installed?: () => string | null; cacheMs?: number } = {}) {
  let clock = 1_000
  const update = new PluginUpdate({
    packageName: NAME,
    manager: () => face,
    installed: options.installed ?? (() => '0.6.1'),
    now: () => clock,
    cacheMs: options.cacheMs,
    requestId: () => 'request-1',
  })
  return { update, tick: (ms: number) => { clock += ms } }
}

describe('pickUpdate', () => {
  it('skips prereleases, non-bundles and incompatible versions in the manager order', () => {
    const versions = [
      { version: '0.9.0-rc.1', prerelease: true, bundle: true },
      { version: '0.8.0', prerelease: false, bundle: true, incompatible: { dsh: '>=0.3' } },
      { version: '0.7.5', prerelease: false, bundle: false },
      { version: '0.7.0', prerelease: false, bundle: true },
      { version: '0.6.3', prerelease: false, bundle: true },
    ]
    expect(pickUpdate(versions)?.version).toBe('0.7.0')
  })

  it('reports no candidate when every version is filtered out', () => {
    expect(pickUpdate([{ version: '0.9.0-beta.1', prerelease: true, bundle: true }])).toBeUndefined()
  })
})

describe('check', () => {
  it('offers the newest compatible stable release', async () => {
    const { face } = manager({ versions: async () => ({ ok: true, value: listed([{ version: '0.7.1' }, { version: '0.7.0' }]) }) })
    const { update } = store(face)
    const snapshot = await update.check()
    expect(snapshot.phase).toBe('available')
    expect(snapshot.latest).toBe('0.7.1')
    expect(snapshot.installed).toBe('0.6.2')
    expect(updateCard(snapshot)).toMatchObject({ version: '0.6.2', action: '更新到 0.7.1', tone: 'warn' })
  })

  it('caches a result for ten minutes and re-asks only when asked to', async () => {
    const { face, calls } = manager()
    const { update, tick } = store(face)
    await update.check()
    expect(calls).toMatchObject({ bundles: 1, versions: 1 })
    tick(UPDATE_CACHE_MS - 1)
    await update.check()
    expect(calls).toMatchObject({ bundles: 1, versions: 1 })
    tick(2)
    await update.check()
    expect(calls).toMatchObject({ bundles: 2, versions: 2 })
    await update.check(true)
    expect(calls).toMatchObject({ bundles: 3, versions: 3 })
  })

  it('reports the newest version when none is newer', async () => {
    const { face } = manager({ versions: async () => ({ ok: true, value: listed([]) }) })
    const { update } = store(face)
    const snapshot = await update.check()
    expect(snapshot.phase).toBe('current')
    expect(snapshot.message).toBe('已是最新版本')
    expect(updateCard(snapshot)).toMatchObject({ tone: 'ok', action: '检查更新' })
  })

  it('treats a missing plugin manager as a manual update, not an error', async () => {
    const { update } = store(null)
    const snapshot = await update.check()
    expect(snapshot.phase).toBe('unsupported')
    expect(snapshot.message).toBe('请通过 DSH 插件管理器手动更新')
    expect(snapshot.detail).toContain('没有连到 DSH 插件管理器')
    expect(updateCard(snapshot)).toMatchObject({ action: '检查更新', tone: 'neutral' })
  })

  it('explains an installation that cannot be updated automatically', async () => {
    const { face } = manager({ bundles: async () => ({ ok: true, value: [bundle({ update: undefined })] }) })
    const { update } = store(face)
    const snapshot = await update.check()
    expect(snapshot.phase).toBe('unsupported')
    expect(snapshot.message).toBe('请通过 DSH 插件管理器手动更新')
    expect(snapshot.detail).toContain('本地链接或 Git 固定提交')
  })

  it('ignores other bundles and reports a plugin the manager does not list', async () => {
    const other = manager({ bundles: async () => ({ ok: true, value: [bundle({ name: 'someone-else' })] }) })
    expect((await store(other.face).update.check()).phase).toBe('unsupported')

    const both = manager({ bundles: async () => ({ ok: true, value: [bundle({ name: 'someone-else' }), bundle()] }) })
    expect((await store(both.face).update.check()).phase).toBe('available')
  })

  it('maps a refused not-updatable answer to the manual hint', async () => {
    const { face } = manager({ versions: async () => ({ ok: true, value: { status: 'refused', problem: 'not-updatable', reason: 'link: dependency' } }) })
    const { update } = store(face)
    const snapshot = await update.check()
    expect(snapshot.phase).toBe('unsupported')
    expect(snapshot.detail).toBe('link: dependency')
  })

  it('reports network failures and rejected queries as errors the user can retry', async () => {
    const network = manager({ versions: async () => ({ ok: true, value: { status: 'refused', problem: 'network', reason: 'ENOTFOUND' } }) })
    const networkSnapshot = await store(network.face).update.check()
    expect(networkSnapshot.phase).toBe('error')
    expect(networkSnapshot.detail).toContain('网络')

    const refused = manager({ bundles: async () => ({ ok: false, error: { message: '拒绝访问' } }) })
    const refusedSnapshot = await store(refused.face).update.check()
    expect(refusedSnapshot).toMatchObject({ phase: 'error', detail: '拒绝访问' })
    expect(updateCard(refusedSnapshot)).toMatchObject({ action: '重新检查', tone: 'danger' })

    const broken = manager({ bundles: async () => { throw new Error('连接被重置') } })
    expect((await store(broken.face).update.check()).detail).toBe('连接被重置')
  })

  it('falls back to the Host version when the manager reports none', async () => {
    const { face } = manager({
      bundles: async () => ({ ok: true, value: [bundle({ version: undefined })] }),
      versions: async () => ({ ok: true, value: { status: 'listed', registry: 'https://registry.npmjs.org', versions: [{ version: '0.7.0', prerelease: false, bundle: true }], omitted: 0 } }),
    })
    const { update } = store(face, { installed: () => '0.6.1' })
    expect((await update.check()).installed).toBe('0.6.1')
  })
})

describe('update', () => {
  it('asks for confirmation before installing, and cancellation returns to the offer', async () => {
    const { face, calls } = manager()
    const { update } = store(face)
    await update.check()
    update.ask()
    expect(update.snapshot().confirm).toBe(true)
    expect(updateCard(update.snapshot())).toMatchObject({ action: '确认更新' })
    update.cancel()
    expect(update.snapshot().confirm).toBe(false)
    expect(calls.updates).toHaveLength(0)
  })

  it('installs the offered version through the manager with a request id', async () => {
    const { face, calls } = manager()
    const { update } = store(face)
    await update.check()
    const snapshot = await update.update()
    expect(calls.updates).toEqual([{ version: '0.7.0', registry: 'https://registry.npmjs.org', requestId: 'request-1' }])
    expect(snapshot).toMatchObject({ phase: 'installed', installed: '0.7.0', message: '已更新到 0.7.0' })
    expect(updateCard(snapshot)).toMatchObject({ version: '0.7.0' })
  })

  it('reports a restart requirement instead of promising the running version changed', async () => {
    const { face } = manager({ update: async () => ({ ok: true, value: { result: { changed: true, application: 'restart-required' } } }) })
    const { update } = store(face)
    await update.check()
    const snapshot = await update.update()
    expect(snapshot.message).toBe('已更新到 0.7.0，重启 DSH 后生效')
    expect(snapshot.detail).toContain('手动重启 DSH')
  })

  it('surfaces a failed installation with the manager message', async () => {
    const { face } = manager({ update: async () => ({ ok: true, value: { result: { changed: false, application: 'failed', error: { message: '权限不足' } } } }) })
    const { update } = store(face)
    await update.check()
    expect(await update.update()).toMatchObject({ phase: 'error', message: '更新失败', detail: '权限不足' })
  })

  it('returns to the offer when the user cancels inside the manager', async () => {
    const { face } = manager({ update: async () => ({ ok: true, value: { result: { changed: false, application: 'cancelled' } } }) })
    const { update } = store(face)
    await update.check()
    expect(await update.update()).toMatchObject({ phase: 'available', message: '已取消更新，仍在 0.6.2。' })
  })

  it('recovers an unknown outcome by asking what is installed instead of installing again', async () => {
    let installed = '0.6.2'
    const { face, calls } = manager({
      bundles: async () => ({ ok: true, value: [bundle({ version: installed })] }),
      update: async () => { installed = '0.7.0'; throw new Error('连接中断') },
    })
    const { update } = store(face)
    await update.check()
    const snapshot = await update.update()
    expect(calls.updates).toHaveLength(1)
    expect(snapshot).toMatchObject({ phase: 'installed', installed: '0.7.0', message: '已更新到 0.7.0，重启 DSH 后生效' })
    expect(snapshot.detail).toContain('不需要重复安装')
  })

  it('reports the uncertainty when the installed version did not move', async () => {
    const { face, calls } = manager({ update: async () => { throw new Error('连接中断') } })
    const { update } = store(face)
    await update.check()
    const snapshot = await update.update()
    expect(calls.updates).toHaveLength(1)
    expect(snapshot).toMatchObject({ phase: 'error', message: '更新结果不确定' })
    expect(snapshot.detail).toContain('不要重复更新')
  })

  it('does nothing when no update was offered', async () => {
    const { face, calls } = manager({ versions: async () => ({ ok: true, value: listed([]) }) })
    const { update } = store(face)
    await update.check()
    await update.update()
    expect(calls.updates).toHaveLength(0)
  })
})

describe('resolvePluginManager', () => {
  it('uses the injected manager and tolerates its absence', () => {
    const { face } = manager()
    expect(resolvePluginManager({ manager: face })).toBe(face)
    expect(resolvePluginManager({ manager: null })).toBeNull()
    expect(resolvePluginManager({ manager: { listBundles: () => {} } as unknown as PluginManagerFace })).toBeNull()
    expect(resolvePluginManager({})).toBeNull()
  })

  it('honours the browser QA fixture only when it exposes the full face', () => {
    const { face } = manager()
    const scope = globalThis as { __DSH_RC_UPDATE_FIXTURE__?: unknown }
    scope.__DSH_RC_UPDATE_FIXTURE__ = face
    try { expect(resolvePluginManager({ manager: null })).toBe(face) }
    finally { delete scope.__DSH_RC_UPDATE_FIXTURE__ }
    expect(resolvePluginManager({ manager: null })).toBeNull()
  })

  it('rechecks on demand without caching a manual answer', async () => {
    const { face } = manager()
    let source: PluginManagerFace | null = null
    const update = new PluginUpdate({ packageName: NAME, manager: () => source, installed: () => '0.6.2', requestId: () => 'request-1' })
    await update.check()
    expect(update.snapshot().phase).toBe('unsupported')
    source = face
    await update.check(true)
    expect(update.snapshot().phase).toBe('available')
  })
})

describe('panel wiring', () => {
  it('resolves the plugin manager by name instead of injecting it', () => {
    expect(SOURCE).toContain("export const inject = ['slots', 'connection']")
    expect(SOURCE).toContain("ctx.get?.('remote.pluginManager')")
    expect(SOURCE).toContain('resolvePluginManager({ manager:')
  })

  it('hides the update card from the phone: only the local panel renders it', () => {
    expect(SOURCE).toContain('if (!state?.local) return null')
    expect(SOURCE).toContain('updateSection()')
  })
})
