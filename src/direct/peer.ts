import { randomBytes } from 'node:crypto'
import { DirectBridge, type DirectStats } from './bridge.js'
import { DIRECT_IDLE_TIMEOUT_MS, DIRECT_PROTOCOL, DIRECT_SIGNAL_TTL_MS, readControl, controlPayload, decodeDirectFrame, encodeDirectFrame } from './protocol.js'

/** What the panel and the acceptance tests read back about one live direct line. */
export interface DirectChannelState {
  sessionId: string
  deviceId: string
  connected: boolean
  createdAt: number
  stats: DirectStats
}

export interface DirectHostOptions {
  /** The gateway's loopback port, resolved per request because the gateway can restart. */
  port: () => number
  log?: (message: string) => void
  /** Called when a channel binds to a device, so the gateway can admit its stamped requests. */
  onBind?: (mark: string, deviceId: string, sessionId: string) => void
  /** Called when a channel ends for any reason. */
  onUnbind?: (mark: string) => void
  /** Keepalive period; a channel that misses two answers is closed. */
  keepAliveMs?: number
}

interface Session {
  sessionId: string
  deviceId: string
  mark: string
  createdAt: number
  peer: any
  channel?: any
  bridge?: DirectBridge
  handle?: { handle: (data: Uint8Array) => void; dispose: () => void }
  timer?: ReturnType<typeof setInterval>
  missed: number
  connected: boolean
}

/**
 * The computer's half of the direct line: it answers one offer from a paired phone, keeps the
 * WebRTC peer, and hands the resulting DataChannel to the bridge. werift is imported lazily, so a
 * Host that never enables a direct line never loads it.
 */
export class DirectHost {
  private readonly sessions = new Map<string, Session>()
  private readonly byMark = new Map<string, Session>()
  private readonly byDevice = new Map<string, Set<string>>()
  private loading?: Promise<any>
  private closed = false

  constructor(private readonly options: DirectHostOptions) {}

  private async load(): Promise<any> {
    this.loading ??= import('werift').catch(error => { this.loading = undefined; throw new Error('无法加载 WebRTC 依赖：' + describe(error)) })
    return this.loading
  }

  /** Answer one offer. The caller has already resolved the device from its own cookie. */
  async offer(deviceId: string, sdp: string): Promise<{ sessionId: string; sdp: string }> {
    if (this.closed) throw new Error('直连已关闭。')
    if (typeof sdp !== 'string' || !sdp.startsWith('v=0') || sdp.length > 256 * 1024) throw new Error('直连的协商描述不合法。')
    const { RTCPeerConnection } = await this.load()
    const sessionId = randomBytes(18).toString('base64url')
    const mark = randomBytes(18).toString('base64url')
    const peer = new RTCPeerConnection({ iceServers: [], iceUseDefaultStunServer: false })
    const session: Session = { sessionId, deviceId, mark, createdAt: Date.now(), peer, missed: 0, connected: false }
    peer.onDataChannel.subscribe((channel: any) => this.bindChannel(session, channel))
    peer.connectionStateChange.subscribe((state: string) => {
      this.options.log?.('直连状态 ' + state)
      if (state === 'failed' || state === 'closed' || state === 'disconnected') this.drop(sessionId, 'peer-' + state)
    })
    try {
      await peer.setRemoteDescription({ type: 'offer', sdp })
      const answer = await peer.createAnswer()
      await peer.setLocalDescription(answer)
      for (let step = 0; step < 30 && peer.iceGatheringState !== 'complete'; step++) await new Promise(resolve => setTimeout(resolve, 100))
      const local = peer.localDescription?.sdp
      if (!local) throw new Error('WebRTC 未生成应答。')
      this.sessions.set(sessionId, session)
      const device = this.byDevice.get(deviceId) ?? new Set<string>()
      device.add(sessionId); this.byDevice.set(deviceId, device)
      this.byMark.set(mark, session)
      this.options.onBind?.(mark, deviceId, sessionId)
      return { sessionId, sdp: local }
    } catch (failure) {
      try { await peer.close() } catch { /* the peer may never have started */ }
      throw failure
    }
  }

  private bindChannel(session: Session, channel: any): void {
    if (this.closed || this.sessions.get(session.sessionId) !== session) { try { channel.close() } catch { /* already gone */ } return }
    this.options.log?.('直连通道已建立 ' + session.deviceId)
    session.channel = channel
    const bridge = new DirectBridge({ port: this.options.port, mark: () => session.mark, log: this.options.log })
    const handle = bridge.attach({
      send: (data: Uint8Array) => { try { channel.send(data) } catch { this.drop(session.sessionId, 'send-failed') } },
      close: () => { try { channel.close() } catch { /* already gone */ } },
    })
    session.bridge = bridge
    session.handle = handle
    channel.onMessage.subscribe((message: any) => {
      const bytes = toBytes(message)
      if (!bytes) return
      // The first frame binds the channel: it names the session the answer was issued for.
      if (!session.connected) {
        let frame
        try { frame = decodeDirectFrame(bytes) } catch { this.drop(session.sessionId, 'bad-hello'); return }
        if (frame.t !== 'hello') { this.drop(session.sessionId, 'hello-required'); return }
        const hello = readControl(frame)
        if (hello.sessionId !== session.sessionId || hello.protocol !== DIRECT_PROTOCOL) { this.drop(session.sessionId, 'hello-mismatch'); return }
        session.connected = true
        try { channel.send(encodeDirectFrame({ t: 'hello', id: 'hello', payload: controlPayload({ protocol: DIRECT_PROTOCOL, sessionId: session.sessionId }) })) } catch { /* the frame is advisory */ }
        this.startKeepAlive(session)
        return
      }
      handle.handle(bytes)
    })
    channel.stateChanged?.subscribe?.((state: string) => { if (state === 'closed') this.drop(session.sessionId, 'channel-closed') })
    channel.onClose?.subscribe?.(() => this.drop(session.sessionId, 'channel-closed'))
  }

  private startKeepAlive(session: Session): void {
    const period = this.options.keepAliveMs ?? 10_000
    session.timer = setInterval(() => {
      if (session.missed >= 2) { this.drop(session.sessionId, 'idle'); return }
      session.missed += 1
      try { session.channel?.send(encodeDirectFrame({ t: 'ping', id: 'ka', payload: controlPayload({ at: Date.now() }) })) }
      catch { this.drop(session.sessionId, 'ping-failed') }
    }, period)
    session.timer.unref?.()
  }

  /** One pong resets the miss counter; the bridge answers pings itself, so this is separate. */
  notePong(session: Session): void { session.missed = 0 }

  /** The device a live channel's mark belongs to; undefined until that channel finished its handshake. */
  mark(value: string): string | undefined {
    const session = this.byMark.get(value)
    return session?.connected ? session.deviceId : undefined
  }

  state(): DirectChannelState[] {
    return [...this.sessions.values()].map(session => ({
      sessionId: session.sessionId,
      deviceId: session.deviceId,
      connected: session.connected,
      createdAt: session.createdAt,
      stats: session.bridge?.snapshot() ?? { requests: 0, sockets: 0, received: 0, sent: 0 },
    }))
  }

  /** The device was revoked, or the user asked the line to stop: every channel for it ends now. */
  closeDevice(deviceId: string): void {
    for (const sessionId of [...this.byDevice.get(deviceId) ?? []]) this.drop(sessionId, 'revoked')
    this.byDevice.delete(deviceId)
  }

  drop(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    this.byMark.delete(session.mark)
    const device = this.byDevice.get(session.deviceId)
    if (device) { device.delete(sessionId); if (!device.size) this.byDevice.delete(session.deviceId) }
    if (session.timer) clearInterval(session.timer)
    session.handle?.dispose()
    try { session.channel?.close() } catch { /* already gone */ }
    try { void session.peer.close() } catch { /* already gone */ }
    this.options.onUnbind?.(session.mark)
    this.options.log?.('直连已结束 ' + reason)
  }

  async close(): Promise<void> {
    this.closed = true
    for (const sessionId of [...this.sessions.keys()]) this.drop(sessionId, 'closed')
  }
}

/** Expired sessions that never carried a channel are reaped; offers are cheap but not free. */
export function reapSessions(host: DirectHost, now: number): void {
  for (const state of host.state()) if (!state.connected && now - state.createdAt > DIRECT_SIGNAL_TTL_MS) host.drop(state.sessionId, 'offer-expired')
}

export function idleSessions(host: DirectHost, now: number): void {
  for (const state of host.state()) if (now - state.createdAt > DIRECT_IDLE_TIMEOUT_MS * 20) host.drop(state.sessionId, 'idle')
}

function toBytes(message: unknown): Uint8Array | undefined {
  if (message instanceof Uint8Array) return message
  if (Buffer.isBuffer(message)) return new Uint8Array(message)
  if (Array.isArray(message)) return new Uint8Array(Buffer.concat(message.map(item => Buffer.from(item))))
  if (message instanceof ArrayBuffer) return new Uint8Array(message)
  return undefined
}

function describe(failure: unknown): string {
  const node = failure as NodeJS.ErrnoException | undefined
  return node?.code ?? (failure instanceof Error ? failure.message : String(failure))
}
