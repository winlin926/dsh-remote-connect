import { expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { readLanTls } from '../src/lan-tls.js'

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/lan-tls/${name}.pem`, import.meta.url))
const config = { hostname: 'lan.example.test', certFile: fixture('server'), keyFile: fixture('key-1') }

it('reads a hostname-bound PEM pair and returns its canonical HTTPS origin', async () => {
  const material = await readLanTls({ ...config, hostname: 'LAN.EXAMPLE.TEST' }, 443)
  expect(material.origin).toBe('https://lan.example.test')
  expect(material.expiresAt).toBe(Date.parse('2100-01-01T00:00:00Z'))
  expect(material.cert).toContain('BEGIN CERTIFICATE')
  expect(material.key).toContain('BEGIN PRIVATE KEY')
  expect((await readLanTls(config, 45872)).origin).toBe('https://lan.example.test:45872')
})

it.each(['https://lan.example.test', 'lan.example.test:443', 'lan.example.test/path', '*.example.test', 'lan.example.test.', 'bad_name', '127.0.0.1', '127.1', '::1', ' lan.example.test', ''])('rejects a noncanonical DNS hostname: %s', async hostname => {
  await expect(readLanTls({ ...config, hostname }, 443)).rejects.toThrow(/主机名/)
})

it.each([0, -1, 65536, 4.5, NaN])('requires a fixed valid port: %s', async port => {
  await expect(readLanTls(config, port)).rejects.toThrow(/固定端口/)
})

it.each([
  ['expired', /过期/], ['future', /尚未生效/], ['wrong-host', /SAN/], ['cn-only', /SAN/],
] as const)('rejects an unusable certificate: %s', async (name, message) => {
  await expect(readLanTls({ ...config, certFile: fixture(name) }, 443)).rejects.toThrow(message)
})

it('rejects missing files, malformed PEM and a mismatched private key', async () => {
  await expect(readLanTls({ ...config, certFile: fixture('missing') }, 443)).rejects.toThrow(/读取/)
  await expect(readLanTls({ ...config, certFile: fixture('key-1') }, 443)).rejects.toThrow(/PEM/)
  await expect(readLanTls({ ...config, keyFile: fixture('key-2') }, 443)).rejects.toThrow(/不匹配/)
  await expect(readLanTls({ ...config, keyFile: fixture('server') }, 443)).rejects.toThrow(/私钥/)
})
