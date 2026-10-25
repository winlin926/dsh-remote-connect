import type { Dispatcher } from 'undici'

export interface OutboundProxy {
  readonly address?: string
  fetch(input: string | URL, init?: RequestInit): Promise<Response>
  close(): Promise<void>
}

export function createOutboundProxy(address?: string): OutboundProxy {
  let dispatcher: Dispatcher | undefined
  let destroy: (() => Promise<void>) | undefined
  const ready = address ? import('undici').then(undici => {
    const agent = new undici.ProxyAgent(address)
    dispatcher = agent
    destroy = () => agent.destroy()
  }) : Promise.resolve()
  return {
    address,
    async fetch(input, init) {
      await ready
      return dispatcher ? await (await import('undici')).fetch(input, { ...init, dispatcher } as import('undici').RequestInit) as unknown as Response : fetch(input, init)
    },
    async close() { await ready; await destroy?.() }
  }
}
