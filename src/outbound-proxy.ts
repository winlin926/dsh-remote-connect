import type { Dispatcher } from 'undici'

export function createOutboundProxy(address?: string) {
  let dispatcher: Dispatcher | undefined
  let destroy: (() => Promise<void>) | undefined
  const ready = address ? import('undici').then(undici => {
    const agent = new undici.ProxyAgent(address)
    dispatcher = agent
    destroy = () => agent.destroy()
  }) : Promise.resolve()
  return {
    address,
    async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
      await ready
      return dispatcher ? await (await import('undici')).fetch(input, { ...init, dispatcher } as import('undici').RequestInit) as unknown as Response : fetch(input, init)
    },
    async close() { await ready; await destroy?.() }
  }
}

export type OutboundProxy = ReturnType<typeof createOutboundProxy>
