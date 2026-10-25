import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^127\./.test(host) || /^0\./.test(host) || /^169\.254\./.test(host)) return true
  const match = /^172\.(\d+)\./.exec(host)
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true
  if (host === '::' || host === '::1' || /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) return true
  const mapped = /^::ffff:(?:([0-9]{1,3}(?:[.][0-9]{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(host)
  if (!mapped) return false
  if (mapped[1]) return isPrivateHostname(mapped[1])
  const high = Number.parseInt(mapped[2]!, 16), first = high >> 8, second = high & 0xff
  return first === 0 || first === 10 || first === 127 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31) || (first === 169 && second === 254)
}

/** Only an HTTPS origin can be used; no paths, credentials or private destinations. */
export function normalizePublicUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let parsed: URL
  try { parsed = new URL(trimmed) } catch { throw new Error('公网域名格式无效。') }
  if (parsed.protocol !== 'https:') throw new Error('公网域名必须使用 https。')
  if (parsed.username || parsed.password) throw new Error('公网域名不能包含用户信息。')
  if (parsed.search || parsed.hash) throw new Error('公网域名不能包含查询参数或锚点。')
  if (parsed.pathname !== '/') throw new Error('公网域名不能包含路径。')
  const hostname = parsed.hostname.toLowerCase()
  if (!hostname.includes('.')) throw new Error('公网域名必须包含域名后缀。')
  if (isPrivateHostname(hostname)) throw new Error('公网域名不能是本机、内网或链路本地地址。')
  return parsed.origin
}

export function readPublicUrl(file: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { publicUrl?: unknown }
    return typeof parsed.publicUrl === 'string' ? normalizePublicUrl(parsed.publicUrl) : null
  } catch { return null }
}

export async function writePublicUrl(file: string, publicUrl: string | null): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = join(dirname(file), `.${randomUUID()}.settings.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(publicUrl ? { publicUrl } : {}, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}
