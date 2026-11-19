/**
 * werift ships no declarations in the published bundle. Only the browser-compatible surface this
 * plugin uses is declared, so a wrong member shows up as a type error instead of a runtime one.
 */
declare module 'werift' {
  export interface RTCDataChannel {
    label: string
    readyState: string
    send(data: Uint8Array): void
    close(): void
    onMessage: { subscribe(fn: (message: unknown) => void): void }
    onClose?: { subscribe(fn: () => void): void }
    stateChanged?: { subscribe(fn: (state: string) => void): void }
  }
  export class RTCPeerConnection {
    constructor(config?: { iceServers?: unknown[]; iceUseDefaultStunServer?: boolean })
    readonly iceGatheringState: string
    readonly connectionState: string
    localDescription?: { sdp: string } | null
    onDataChannel: { subscribe(fn: (channel: RTCDataChannel) => void): void }
    connectionStateChange: { subscribe(fn: (state: string) => void): void }
    setRemoteDescription(description: { type: 'offer' | 'answer'; sdp: string }): Promise<void>
    createAnswer(): Promise<{ type: 'answer'; sdp: string }>
    setLocalDescription(description: { type: 'answer'; sdp: string }): Promise<void>
    close(): Promise<void>
  }
}
