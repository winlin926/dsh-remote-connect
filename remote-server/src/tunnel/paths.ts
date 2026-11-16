/**
 * Paths that belong to the relay node itself. Everything else — including `/`,
 * which serves the official DSH UI — is proxied to the Host for paired devices.
 */
const NODE_OWNED_EXACT = new Set(['/healthz', '/favicon.ico', '/v1', '/assets', '/.well-known'])

const NODE_OWNED_PREFIXES = ['/v1/', '/assets/', '/.well-known/', '/pair']

/** True when the relay node handles this pathname without the Host tunnel. */
export function isNodeOwnedPath(pathname: string): boolean {
  if (NODE_OWNED_EXACT.has(pathname)) return true
  return NODE_OWNED_PREFIXES.some(prefix => pathname.startsWith(prefix))
}
