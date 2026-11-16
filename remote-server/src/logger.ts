/** Structured JSON logger that never echoes secrets. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Field names that must never reach a log line, in any nesting depth. */
const SENSITIVE_KEY = /(?:token|ticket|cookie|authorization|credential|secret|password|privatekey|private_key|ciphertext|identitykey|identity_key|pairingtoken)/iu

export type LogFields = { event: string } & Record<string, unknown>

export interface Logger {
  debug(fields: LogFields): void
  info(fields: LogFields): void
  warn(fields: LogFields): void
  error(fields: LogFields): void
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (depth >= 3) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitize(item, depth + 1))
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitize(entry, depth + 1)
    }
    return result
  }
  return String(value)
}

export function createLogger(level: LogLevel = 'info'): Logger {
  const minimum = LEVEL_ORDER[level]
  const write = (entryLevel: LogLevel, fields: LogFields): void => {
    if (LEVEL_ORDER[entryLevel] < minimum) return
    const sanitized = sanitize(fields) as Record<string, unknown>
    const line = JSON.stringify({ ts: new Date().toISOString(), level: entryLevel, ...sanitized })
    process.stdout.write(`${line}\n`)
  }
  return {
    debug: fields => write('debug', fields),
    info: fields => write('info', fields),
    warn: fields => write('warn', fields),
    error: fields => write('error', fields),
  }
}

/** Logger that discards everything; useful in tests. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
