import type { IncomingMessage, ServerResponse } from 'node:http'
import { ApiError } from '../errors.js'

export interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: Record<string, string>
  head: boolean
  ip: string
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void

interface Route {
  method: string
  segments: string[]
  handler: RouteHandler
}

export class Router {
  private readonly routes: Route[] = []

  add(method: string, path: string, handler: RouteHandler): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: path.split('/').filter(segment => segment.length > 0),
      handler,
    })
    return this
  }

  /** Dispatch a request; returns false when no route matches the path. */
  async dispatch(ctx: Omit<RouteContext, 'params' | 'head'>): Promise<boolean> {
    const method = ctx.req.method ?? 'GET'
    const head = method === 'HEAD'
    const effectiveMethod = head ? 'GET' : method
    const pathSegments = ctx.url.pathname.split('/').filter(segment => segment.length > 0)
    let pathMatched = false
    for (const route of this.routes) {
      const params = matchSegments(route.segments, pathSegments)
      if (!params) continue
      pathMatched = true
      if (route.method !== effectiveMethod) continue
      await route.handler({ ...ctx, params, head })
      return true
    }
    if (pathMatched) throw ApiError.methodNotAllowed()
    return false
  }
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  const params: Record<string, string> = {}
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index]!
    if (expected === '*') {
      params['*'] = actual.slice(index).join('/')
      return params
    }
    const value = actual[index]
    if (value === undefined) return null
    if (expected.startsWith(':')) params[expected.slice(1)] = value
    else if (expected !== value) return null
  }
  if (actual.length !== pattern.length) return null
  return params
}
