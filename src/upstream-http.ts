/**
 * The one request-header translation every remote leg uses before it talks to the Host's own
 * loopback WebServer. The gateway and the service-node tunnel both need exactly the same rules:
 * a remote caller is stripped of its own authority headers, and the loopback leg is given the
 * Host session cookie plus the marker that keeps local-only routes out of reach.
 *
 * Pure and side-effect free, so the behaviour can be pinned by a unit test rather than inferred
 * from a live gateway.
 */

/** Set by every remote leg on requests it forwards; the Host's local-only handlers refuse it. */
export const REMOTE_MARK = 'x-dsh-rc-remote'

export interface UpstreamRequestOptions {
  /** The Host WebServer's loopback port. */
  upstreamPort: number
  /** The Host session cookie (`dsh_rc=...`) that authenticates this Host to its own loopback leg. */
  cookie: string
  /** Overrides {@link REMOTE_MARK}; only tests have a reason to. */
  mark?: string
}

/**
 * Headers a remote request may never carry into the loopback leg: its own Host, cookies and
 * credentials, anything that describes the remote connection (hop-by-hop or fetch metadata), and
 * the browser's WebSocket handshake fields, which the loopback `ws` client supplies itself.
 */
const BLOCKED = new Set([
  'host', 'cookie', 'authorization', 'origin', 'referer', 'connection', 'upgrade', 'accept-encoding',
  'forwarded', 'sec-fetch-site', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions',
  'sec-websocket-protocol',
])

/**
 * Build the headers of one loopback request from the remote request's headers.
 *
 * `x-forwarded-*` and `x-dsh*` are proxy/Host metadata and never cross inward; everything else is
 * kept byte for byte, including array values such as `set-cookie`, while `undefined` entries are
 * skipped. The injected envelope is what makes the loopback leg authenticate as this Host:
 * `host`, the Host session `cookie`, {@link REMOTE_MARK}, `origin`, `sec-fetch-site` and
 * `accept-encoding: identity` (responses must reach the remote caller in their stored bytes).
 */
export function upstreamRequestHeaders(
  req: { headers: Record<string, string | string[] | undefined> },
  options: UpstreamRequestOptions,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined && !BLOCKED.has(name) && !name.startsWith('x-forwarded') && !name.startsWith('x-dsh')) headers[name] = value
  }
  const host = `127.0.0.1:${options.upstreamPort}`
  return {
    ...headers,
    host,
    cookie: options.cookie,
    [options.mark ?? REMOTE_MARK]: '1',
    origin: `http://${host}`,
    'sec-fetch-site': 'same-origin',
    'accept-encoding': 'identity',
  }
}
