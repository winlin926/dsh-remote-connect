/**
 * "Check for updates" for this plugin inside the remote-control panel.
 *
 * The card talks to the DSH plugin manager's client face and nothing else: it never contacts npm,
 * never runs a shell and never asks the Host for an update endpoint. The manager owns version
 * discovery and installation, so the panel only decides what to show and when to ask the user.
 */
export interface UpdateBundle {
  name: string
  installed: boolean
  version?: string
  update?: 'registry' | 'git'
}
export interface UpdateVersion {
  version: string
  prerelease: boolean
  bundle: boolean
  deprecated?: boolean
  incompatible?: unknown
}
export type UpdateVersionList =
  | { status: 'listed'; installed?: string; registry?: string; versions: UpdateVersion[] }
  | { status: 'refused'; problem: 'not-updatable' | 'not-found' | 'network' | 'unknown'; reason: string }
export interface UpdateChange {
  changed: boolean
  application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  error?: { message?: string }
}
export interface UpdateResult { from?: string; to?: string; result: UpdateChange }
/** Typert answers every Remote call with this union instead of throwing. */
export type UpdateAnswer<T> = { ok: true; value: T } | { ok: false; error: { message?: string } }
/** The three plugin-manager methods this card uses; anything missing means "update it by hand". */
export interface PluginManagerFace {
  listBundles(): Promise<UpdateAnswer<UpdateBundle[]>>
  listVersions(name: string, options: Record<string, never>): Promise<UpdateAnswer<UpdateVersionList>>
  updateBundle(name: string, version: string, options: { registry?: string; requestId: string }): Promise<UpdateAnswer<UpdateResult>>
}

export type UpdatePhase = 'idle' | 'checking' | 'current' | 'available' | 'unsupported' | 'error' | 'updating' | 'installed'
export interface UpdateSnapshot {
  phase: UpdatePhase
  /** Version the manager reports as installed, or the Host's own version when it reports none. */
  installed: string | null
  latest: string | null
  checkedAt: number | null
  progress: 'checking' | 'removing' | 'installing' | 'restoring' | null
  /** One line the card shows as its status. */
  message: string
  /** A second line with the reason for an unsupported installation or a failure. */
  detail: string
  /** The user asked to update and must answer before anything is installed. */
  confirm: boolean
  busy: boolean
}

const STABLE = (item: UpdateVersion): boolean => item.bundle && !item.prerelease && item.incompatible == null
/** The manager lists candidates newest first, so the first stable bundle is the one to offer. */
export function pickUpdate(versions: readonly UpdateVersion[]): UpdateVersion | undefined {
  return versions.find(STABLE)
}
const MANUAL = '请通过 DSH 插件管理器手动更新'
const FALLBACK_MANUAL = `${MANUAL}。`

export interface UpdateOptions {
  packageName: string
  /** Resolved on every call: the manager may arrive after the panel mounts, or never at all. */
  manager: () => PluginManagerFace | null
  /** The Host's version, used when the manager does not report one. */
  installed?: () => string | null
  now?: () => number
  cacheMs?: number
  requestId?: () => string
}

/** One check per mount, cached for ten minutes; a manual check always asks the manager again. */
export const UPDATE_CACHE_MS = 10 * 60 * 1000

export class PluginUpdate {
  private state: UpdateSnapshot = { phase: 'idle', installed: null, latest: null, checkedAt: null, progress: null, message: '尚未检查更新', detail: '', confirm: false, busy: false }
  private readonly listeners = new Set<() => void>()
  private readonly now: () => number
  private readonly cacheMs: number
  private readonly requestId: () => string
  private generation = 0
  /** The registry the version list came from: the manager wants it back when installing. */
  private registry: string | undefined

  constructor(private readonly options: UpdateOptions) {
    this.now = options.now ?? (() => Date.now())
    this.cacheMs = options.cacheMs ?? UPDATE_CACHE_MS
    this.requestId = options.requestId ?? (() => globalThis.crypto?.randomUUID?.() ?? `rc-${Math.random().toString(36).slice(2)}${this.now()}`)
    this.patch({ installed: options.installed?.() ?? null })
  }
  snapshot(): UpdateSnapshot { return this.state }
  /** The Host's version fills in until the plugin manager reports the installed bundle. */
  noteInstalled(version: string | null): void {
    if (!version || this.state.phase === 'updating' || this.state.phase === 'installed') return
    if (version !== this.state.installed) this.patch({ installed: version })
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private patch(change: Partial<UpdateSnapshot>): void { this.state = { ...this.state, ...change }; for (const listener of this.listeners) listener() }
  /** The resolver is user code: a lazy remote member can throw while the Host is still starting. */
  private manager(): PluginManagerFace | null {
    try { return this.options.manager() } catch { return null }
  }
  private fail(detail: string): void {
    this.patch({ phase: 'error', busy: false, progress: null, confirm: false, message: '检查更新失败', detail: explainFailure(detail), checkedAt: this.now() })
  }

  /** Ask the manager for the newest compatible release. Cached results keep panel polls silent. */
  async check(force = false): Promise<UpdateSnapshot> {
    if (this.state.phase === 'checking' || this.state.phase === 'updating') return this.state
    if (!force && this.state.checkedAt !== null && this.now() - this.state.checkedAt < this.cacheMs) return this.state
    let manager: PluginManagerFace | null
    try { manager = this.options.manager() } catch (failure) {
      this.fail(failure instanceof Error ? failure.message : '无法解析 DSH 插件管理器。')
      return this.state
    }
    if (!manager) {
      this.patch({ phase: 'unsupported', busy: false, message: MANUAL, detail: '当前面板没有连到 DSH 插件管理器，可能是宿主版本较旧或面板在受限环境下打开。', checkedAt: this.now() })
      return this.state
    }
    const ticket = ++this.generation
    this.patch({ phase: 'checking', busy: true, confirm: false, progress: null, message: '正在检查更新…', detail: '' })
    let bundles: UpdateBundle[]
    try {
      const answer = await manager.listBundles()
      if (!answer.ok) { if (ticket === this.generation) this.fail(answer.error?.message || '插件管理器拒绝了本次查询。'); return this.state }
      bundles = answer.value
    } catch (failure) {
      if (ticket === this.generation) this.fail(failure instanceof Error ? failure.message : '无法连接插件管理器。')
      return this.state
    }
    if (ticket !== this.generation) return this.state
    const bundle = bundles.find(item => item.name === this.options.packageName)
    const installed = bundle?.version ?? this.options.installed?.() ?? null
    if (!bundle) {
      this.patch({ installed, phase: 'unsupported', busy: false, message: MANUAL, detail: `插件管理器里没有 ${this.options.packageName}，可能不是通过插件源安装的。`, checkedAt: this.now() })
      return this.state
    }
    // A `link:` profile dependency or a Git checkout has no registry version to move to.
    if (bundle.update === undefined) {
      this.patch({ installed, phase: 'unsupported', busy: false, message: MANUAL, detail: '当前安装方式（本地链接或 Git 固定提交）不提供自动更新。', checkedAt: this.now() })
      return this.state
    }
    let list: UpdateVersionList
    try {
      const answer = await manager.listVersions(this.options.packageName, {})
      if (!answer.ok) { if (ticket === this.generation) this.fail(answer.error?.message || '插件管理器拒绝了版本查询。'); return this.state }
      list = answer.value
    } catch (failure) {
      if (ticket === this.generation) this.fail(failure instanceof Error ? failure.message : '无法读取可用版本。')
      return this.state
    }
    if (ticket !== this.generation) return this.state
    if (list.status === 'refused') {
      if (list.problem === 'not-updatable') {
        this.patch({ installed, phase: 'unsupported', busy: false, message: MANUAL, detail: list.reason || '当前安装方式不提供自动更新。', checkedAt: this.now() })
      } else if (list.problem === 'network') {
        this.fail(`读取版本列表时网络出错。${list.reason ? ` ${list.reason}` : ''}`.trim())
      } else {
        this.fail(list.reason || '插件管理器没有找到可用的发行版本。')
      }
      return this.state
    }
    const reported = list.installed ?? installed
    this.registry = list.registry
    const next = pickUpdate(list.versions)
    if (!next) {
      this.patch({ installed: reported, phase: 'current', busy: false, latest: reported, checkedAt: this.now(), message: '已是最新版本', detail: '' })
      return this.state
    }
    this.patch({ installed: reported, latest: next.version, phase: 'available', busy: false, checkedAt: this.now(), message: `可更新到 ${next.version}`, detail: '更新由 DSH 插件管理器安装；完成后可能需要手动重启 DSH。' })
    return this.state
  }
  /** First click on the update button asks; the second installs. */
  ask(): void {
    if (this.state.phase !== 'available' || this.state.busy) return
    this.patch({ confirm: true, message: `确认更新到 ${this.state.latest}？`, detail: '更新完成后可能需要手动重启 DSH，远程连接会在重启期间暂时断开。' })
  }
  cancel(): void {
    if (this.state.busy) return
    this.patch({ confirm: false, phase: 'available', message: `可更新到 ${this.state.latest}`, detail: '更新由 DSH 插件管理器安装；完成后可能需要手动重启 DSH。' })
  }

  /** Install the offered version. The manager's answer decides what the card reports. */
  async update(): Promise<UpdateSnapshot> {
    if (this.state.phase !== 'available' || !this.state.latest || this.state.busy) return this.state
    const manager = this.manager()
    if (!manager) { this.patch({ phase: 'unsupported', confirm: false, message: MANUAL, detail: FALLBACK_MANUAL }); return this.state }
    const target = this.state.latest, ticket = ++this.generation
    this.patch({ phase: 'updating', busy: true, confirm: false, progress: 'checking', message: `正在更新到 ${target}…`, detail: '插件管理器正在安装；请不要关闭 DSH。' })
    let answer: UpdateAnswer<UpdateResult>
    try {
      answer = await manager.updateBundle(this.options.packageName, target, {
        ...(this.registry ? { registry: this.registry } : {}), requestId: this.requestId(),
      })
    } catch {
      return this.settle(ticket, target)
    }
    if (ticket !== this.generation) return this.state
    if (!answer.ok) return this.settle(ticket, target, answer.error?.message)
    const application = answer.value.result.application
    if (application === 'cancelled') {
      this.patch({ phase: 'available', busy: false, progress: null, message: `已取消更新，仍在 ${this.state.installed ?? '当前版本'}。`, detail: '' })
      return this.state
    }
    if (application === 'failed') {
      this.patch({ phase: 'error', busy: false, progress: null, message: '更新失败', detail: explainFailure(answer.value.result.error?.message || '插件管理器没有完成安装。'), checkedAt: this.now() })
      return this.state
    }
    // `restart-required` is the normal outcome: the profile already points at the new bytes.
    this.patch({ phase: 'installed', busy: false, progress: null, latest: target, installed: target, checkedAt: this.now(),
      message: application === 'restart-required' ? `已更新到 ${target}，重启 DSH 后生效` : `已更新到 ${target}`,
      detail: application === 'restart-required' ? '现在可以手动重启 DSH；重启后本面板会显示新版本。' : '' })
    return this.state
  }
  /**
   * A transport failure leaves the outcome unknown. Ask the manager what is installed instead of
   * installing again: a second call could race the first one.
   */
  private async settle(ticket: number, target: string, reason?: string): Promise<UpdateSnapshot> {
    const manager = this.manager()
    if (manager) {
      try {
        const answer = await manager.listBundles()
        if (ticket === this.generation && answer.ok) {
          const bundle = answer.value.find(item => item.name === this.options.packageName)
          if (bundle?.version === target) {
            this.patch({ phase: 'installed', busy: false, progress: null, installed: target, latest: target, checkedAt: this.now(), message: `已更新到 ${target}，重启 DSH 后生效`, detail: '上一次更新已经完成，不需要重复安装。' })
            return this.state
          }
        }
      } catch { /* the manager is unreachable as well; report the uncertainty below */ }
    }
    if (ticket === this.generation) this.patch({ phase: 'error', busy: false, progress: null, message: '更新结果不确定', detail: `${reason ? `${reason} ` : ''}请打开 DSH 插件管理器确认已安装版本；确认前不要重复更新。`, checkedAt: this.now() })
    return this.state
  }
}

/** Resolve the client-side plugin manager lazily; a missing service is a normal, supported state. */
/** One resolved manager slot: the Client injects the remote namespace into it when the Host mounts it. */
export interface ManagerSource { manager?: PluginManagerFace | null }

export function resolvePluginManager(source: ManagerSource): PluginManagerFace | null {
  const fixture = (globalThis as { __DSH_RC_UPDATE_FIXTURE__?: unknown }).__DSH_RC_UPDATE_FIXTURE__
  if (face(fixture)) return fixture
  return face(source.manager) ? source.manager : null
}
function face(value: unknown): value is PluginManagerFace {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.listBundles === 'function' && typeof candidate.listVersions === 'function' && typeof candidate.updateBundle === 'function'
}

export type UpdateTone = 'ok' | 'warn' | 'danger' | 'neutral'
export interface UpdateCard {
  version: string
  status: string
  detail: string
  tone: UpdateTone
  /** Primary button label, or null when the card only reports state. */
  action: string | null
}
/** The manager's failure text can be a whole Node stack; the card has one line to give. */
export function explainFailure(detail: string): string {
  const text = detail.trim()
  if (!text) return '插件管理器没有返回原因。'
  if (/MODULE_NOT_FOUND/.test(text) && /pnpm/.test(text)) return 'DSH 安装缺少内置运行时（找不到 pnpm），请重装或修复 DSH 后重试。'
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  return lines.find(line => /error|错误|失败|超时|timeout/i.test(line)) ?? lines[0] ?? text
}
/** Everything the card renders, derived from the snapshot so the component stays dumb. */
export function updateCard(snapshot: UpdateSnapshot): UpdateCard {
  const version = snapshot.installed ?? '未知'
  const tone: UpdateTone = snapshot.phase === 'error' ? 'danger'
    : snapshot.phase === 'available' || snapshot.phase === 'installed' ? 'warn'
      : snapshot.phase === 'current' ? 'ok' : 'neutral'
  const action = snapshot.phase === 'updating' ? null
    : snapshot.phase === 'available' ? (snapshot.confirm ? '确认更新' : `更新到 ${snapshot.latest}`)
      : snapshot.phase === 'error' ? '重新检查' : '检查更新'
  return { version, status: snapshot.message, detail: snapshot.detail, tone, action }
}
