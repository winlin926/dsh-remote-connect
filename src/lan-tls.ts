import { createPrivateKey, X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { createSecureContext } from 'node:tls'

export interface LanTlsConfig { hostname: string; certFile: string; keyFile: string }
export interface LanTlsMaterial { origin: string; expiresAt: number; cert: string; key: string }

export async function readLanTls(config: LanTlsConfig, port: number): Promise<LanTlsMaterial> {
  const hostname = config.hostname.toLowerCase()
  if (hostname.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(hostname) || isIP(hostname)) throw new Error('局域网 HTTPS 主机名必须是 DNS 名称，不能包含协议、端口或路径。')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('局域网 HTTPS 需要 1–65535 的固定端口。')
  const address = new URL(`https://${hostname}:${port}`)
  if (address.hostname !== hostname) throw new Error('局域网 HTTPS 主机名必须是 DNS 名称。')
  let cert: string, key: string
  try { [cert, key] = await Promise.all([readFile(config.certFile, 'utf8'), readFile(config.keyFile, 'utf8')]) }
  catch (cause) { throw new Error('无法读取局域网 HTTPS 证书或私钥文件。', { cause }) }
  let certificate: X509Certificate
  try { certificate = new X509Certificate(cert) }
  catch (cause) { throw new Error('局域网 HTTPS 证书不是有效的 PEM 证书。', { cause }) }
  const expiresAt = Date.parse(certificate.validTo), startsAt = Date.parse(certificate.validFrom), now = Date.now()
  if (!Number.isFinite(expiresAt) || !Number.isFinite(startsAt) || expiresAt <= now) throw new Error('局域网 HTTPS 证书已过期或有效期无效。')
  if (startsAt > now) throw new Error('局域网 HTTPS 证书尚未生效。')
  if (!certificate.subjectAltName || !certificate.checkHost(hostname, { subject: 'never' })) throw new Error('局域网 HTTPS 证书的 SAN 不包含配置的主机名。')
  try {
    if (!certificate.checkPrivateKey(createPrivateKey(key))) throw new Error('key mismatch')
    createSecureContext({ cert, key })
  } catch (cause) { throw new Error('局域网 HTTPS 私钥无效或与证书不匹配。', { cause }) }
  return { origin: address.origin, expiresAt, cert, key }
}
