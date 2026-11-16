#!/usr/bin/env node
/**
 * v2 公网节点契约验收脚本（零依赖，Node 24 原生 fetch）。
 *
 * 用法（先构建服务端）：
 *   cd remote-server
 *   npm run build
 *   cd ..
 *   node scripts/verify-node-v2.mjs
 *
 * 它会在临时 DATA_DIR、随机端口启动 dist 里的 remote-server，按
 * docs/public-node.md 断言：
 *   - GET /.well-known/dsh-remote 返回 protocol:2 的 service 文档；
 *   - node.id / node.fingerprint 与 node.publicKey 的 sha256(SPKI DER) 自洽；
 *   - 服务节点没有扁平 hostId/fingerprint；
 *   - GET /healthz 200；GET /v1/config 的 protocol 为 2；
 *   - 不传注册令牌 POST /v1/hosts 返回 201；
 *   - 节点身份文件存在且与发现文档一致，重启后 node.id 稳定。
 *
 * 结果以可粘贴的 JSON 打印；全部通过退出码 0，否则 1。
 */
import { spawn } from 'node:child_process'
import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverDir = path.join(root, 'remote-server')
const distCandidates = [
  path.join(serverDir, 'dist', 'remote-server', 'src', 'main.js'),
  path.join(serverDir, 'dist', 'main.js'),
]
const WELL_KNOWN = '/.well-known/dsh-remote'
const logs = []
const checks = []

function check(name, fn) {
  try {
    const detail = fn()
    checks.push({ name, ok: true, ...(detail === undefined ? {} : { detail }) })
    return true
  } catch (error) {
    checks.push({ name, ok: false, error: error.message })
    return false
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn()
    checks.push({ name, ok: true, ...(detail === undefined ? {} : { detail }) })
    return true
  } catch (error) {
    checks.push({ name, ok: false, error: error.message })
    return false
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest()
}

function base64url(buffer) {
  return buffer.toString('base64url')
}

function fingerprintOf(digest) {
  return digest.subarray(0, 16).toString('hex')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  if (!address || typeof address === 'string') throw new Error('无法分配随机端口。')
  return address.port
}

function identityKeyPair() {
  const { publicKey } = generateKeyPairSync('ed25519')
  return base64url(publicKey.export({ format: 'der', type: 'spki' }))
}

function startServer({ main, port, dataDir }) {
  const child = spawn(process.execPath, [main], {
    cwd: serverDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      BIND_HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      PUBLIC_ORIGIN: 'https://verify-node-v2.example.com',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => logs.push({ stream: 'stdout', text: chunk.trimEnd() }))
  child.stderr.on('data', (chunk) => logs.push({ stream: 'stderr', text: chunk.trimEnd() }))
  return child
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return
  child.kill()
  const exited = new Promise((resolve) => child.once('exit', resolve))
  const timeout = sleep(5_000).then(() => 'timeout')
  const result = await Promise.race([exited, timeout])
  if (result === 'timeout') {
    child.kill('SIGKILL')
    await Promise.race([exited, sleep(2_000)])
  }
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`服务端提前退出（code=${child.exitCode}）：${tailLogs()}`)
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch {
      // 尚未就绪，继续轮询。
    }
    await sleep(200)
  }
  throw new Error(`20 秒内 /healthz 未就绪：${tailLogs()}`)
}

function tailLogs(limit = 12) {
  return logs.slice(-limit).map((entry) => `[${entry.stream}] ${entry.text}`).join('\n')
}

async function verifyDiscovery(baseUrl, dataDir) {
  const response = await fetch(baseUrl + WELL_KNOWN, {
    redirect: 'manual',
    headers: { accept: 'application/json' },
  })
  assert(response.status === 200, `发现端点状态码 ${response.status}，期望 200。`)
  assert(response.type !== 'opaqueredirect', '发现端点返回了重定向。')
  const contentType = response.headers.get('content-type') ?? ''
  assert(contentType.includes('application/json'), `content-type 为「${contentType}」，期望 application/json。`)
  const cacheControl = response.headers.get('cache-control') ?? ''
  assert(cacheControl.includes('no-store'), `cache-control 为「${cacheControl}」，期望含 no-store。`)
  const body = await response.json()
  assert(body && typeof body === 'object' && !Array.isArray(body), '发现文档不是 JSON 对象。')

  check('well-known: protocol 为数字 2', () => {
    assert(body.protocol === 2, `protocol 为 ${JSON.stringify(body.protocol)}，期望数字 2。`)
    return body.protocol
  })
  check('well-known: kind 为 service', () => {
    assert(body.kind === 'service', `kind 为 ${JSON.stringify(body.kind)}，期望 "service"。`)
    return body.kind
  })
  check('well-known: name 为 1-64 码点且无控制字符', () => {
    assert(typeof body.name === 'string', 'name 不是字符串。')
    const points = [...body.name]
    assert(points.length >= 1 && points.length <= 64, `name 长度为 ${points.length}，期望 1-64。`)
    assert(!/[\u0000-\u001f\u007f]/.test(body.name), 'name 含控制字符。')
    return body.name
  })
  check('well-known: version 匹配契约正则', () => {
    assert(typeof body.version === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/.test(body.version), `version 为 ${JSON.stringify(body.version)}。`)
    return body.version
  })
  check('well-known: capabilities 含 pairing 且都在 v2 白名单内', () => {
    assert(Array.isArray(body.capabilities) && body.capabilities.length > 0, 'capabilities 不是非空数组。')
    const allowed = new Set(['pairing', 'cache', 'official-ui', 'relay', 'turn'])
    const advertised = new Set(['pairing', 'cache', 'official-ui'])
    for (const item of body.capabilities) {
      assert(typeof item === 'string' && allowed.has(item), `capabilities 含未知能力 ${JSON.stringify(item)}。`)
      assert(advertised.has(item), `0.6.2 节点不得宣告 ${JSON.stringify(item)}（仅为将来版本保留）。`)
    }
    assert(body.capabilities.includes('pairing'), 'capabilities 缺少必需的 pairing。')
    return body.capabilities
  })
  check('well-known: 服务节点没有扁平 hostId/fingerprint', () => {
    assert(!Object.hasOwn(body, 'hostId'), '发现文档出现了扁平 hostId；服务节点不得携带。')
    assert(!Object.hasOwn(body, 'fingerprint'), '发现文档出现了扁平 fingerprint；服务节点不得携带。')
  })

  const node = body.node
  check('well-known: node 为对象且三个字段都是字符串', () => {
    assert(node && typeof node === 'object' && !Array.isArray(node), 'node 缺失或不是对象。')
    for (const key of ['id', 'fingerprint', 'publicKey']) {
      assert(typeof node[key] === 'string' && node[key].length > 0, `node.${key} 缺失或不是字符串。`)
    }
    return { id: node.id, fingerprint: node.fingerprint }
  })
  check('well-known: node.id 为 43 字符 base64url', () => {
    assert(/^[A-Za-z0-9_-]{43}$/.test(node.id), `node.id 为 ${JSON.stringify(node.id)}，期望 43 字符 base64url。`)
    return node.id
  })
  check('well-known: node.fingerprint 为 32 位小写 hex', () => {
    assert(/^[a-f0-9]{32}$/.test(node.fingerprint), `node.fingerprint 为 ${JSON.stringify(node.fingerprint)}，期望 32 位小写 hex。`)
    return node.fingerprint
  })
  check('well-known: node.publicKey 为 Ed25519 SPKI DER 且 sha256 自洽', () => {
    let der
    try {
      der = Buffer.from(node.publicKey, 'base64url')
    } catch {
      throw new Error('node.publicKey 不是合法 base64url。')
    }
    assert(der.length > 0, 'node.publicKey 解码为空。')
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
    assert(key.asymmetricKeyType === 'ed25519', `node.publicKey 不是 Ed25519（${key.asymmetricKeyType}）。`)
    const digest = sha256(der)
    assert(base64url(digest) === node.id, `sha256(SPKI DER) 的 base64url 与 node.id 不一致：${base64url(digest)} != ${node.id}。`)
    assert(fingerprintOf(digest) === node.fingerprint, `sha256(SPKI DER) 前 16 字节与 node.fingerprint 不一致：${fingerprintOf(digest)} != ${node.fingerprint}。`)
    return { algorithm: key.asymmetricKeyType, digest: fingerprintOf(digest) }
  })

  // 节点身份文件：与发现文档一致，0600（Windows 不检查 mode）。
  const identityPath = path.join(dataDir, 'node-identity.json')
  await checkAsync('node-identity.json 已生成且与发现文档一致', async () => {
    assert(existsSync(identityPath), `${identityPath} 不存在。`)
    const text = await readFile(identityPath, 'utf8')
    const identity = JSON.parse(text)
    assert(identity.version === 1, `node-identity.json 的 version 为 ${JSON.stringify(identity.version)}。`)
    assert(identity.algorithm === 'ed25519', `algorithm 为 ${JSON.stringify(identity.algorithm)}。`)
    assert(typeof identity.publicKey === 'string' && identity.publicKey === node.publicKey, 'node-identity.json 的 publicKey 与发现文档不一致。')
    assert(typeof identity.privateKey === 'string' && identity.privateKey.length > 0, 'node-identity.json 缺少 privateKey。')
    if (process.platform !== 'win32') {
      const mode = (await stat(identityPath)).mode & 0o777
      assert(mode === 0o600, `node-identity.json 权限为 0o${mode.toString(8)}，期望 0o600。`)
    }
    return { path: identityPath, mode: process.platform === 'win32' ? 'skipped-on-win32' : '0600' }
  })

  return { body, node }
}

async function verifyHttp(baseUrl) {
  await checkAsync('healthz 返回 200 且 ok:true', async () => {
    const response = await fetch(`${baseUrl}/healthz`)
    assert(response.status === 200, `/healthz 状态码 ${response.status}。`)
    const body = await response.json()
    assert(body && body.ok === true, `/healthz 响应 ${JSON.stringify(body)}。`)
    return { status: response.status, version: body.version }
  })

  await checkAsync('v1/config 返回 protocol:2 且不含密钥', async () => {
    const response = await fetch(`${baseUrl}/v1/config`)
    assert(response.status === 200, `/v1/config 状态码 ${response.status}。`)
    const body = await response.json()
    assert(body && typeof body === 'object', '/v1/config 不是 JSON 对象。')
    assert(body.protocol === 2, `/v1/config 的 protocol 为 ${JSON.stringify(body.protocol)}，期望 2。`)
    const text = JSON.stringify(body)
    for (const key of ['privateKey', 'publicKey', 'secret', 'token']) {
      assert(!text.includes(`"${key}"`), `/v1/config 泄露了 ${key} 字段。`)
    }
    return { protocol: body.protocol, kind: body.kind, capabilities: body.capabilities }
  })

  await checkAsync('注册无令牌：POST /v1/hosts 返回 201', async () => {
    const identityKey = identityKeyPair()
    const response = await fetch(`${baseUrl}/v1/hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: randomUUID(),
        name: 'verify-node-v2',
        identityKey,
        clientVersion: '0.6.2',
      }),
    })
    const text = await response.text()
    assert(response.status === 201, `注册状态码 ${response.status}，期望 201（不得要求注册令牌）：${text.slice(0, 300)}`)
    const body = JSON.parse(text)
    assert(typeof body.credential === 'string' && body.credential.length > 0, '注册响应缺少 credential。')
    assert(body.host && /^[A-Za-z0-9_-]{43}$/.test(body.host.hostId), '注册响应缺少合法的 host.hostId。')
    return { status: response.status, hostId: body.host.hostId }
  })
}

async function main() {
  const startedAt = Date.now()
  const mainPath = distCandidates.find((candidate) => existsSync(candidate))
  if (!mainPath) {
    const output = {
      ok: false,
      error: 'not-built',
      message: '未找到服务端构建产物，请先在 remote-server/ 运行 npm run build。',
      searched: distCandidates,
    }
    console.log(JSON.stringify(output, null, 2))
    process.exitCode = 1
    return
  }

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-verify-node-v2-'))
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  let child = startServer({ main: mainPath, port, dataDir })
  let discovery
  const result = { ok: false, baseUrl, main: mainPath, dataDir }

  try {
    await checkAsync('服务端启动并通过 /healthz', () => waitForHealth(baseUrl, child))
    discovery = await verifyDiscovery(baseUrl, dataDir)
    await verifyHttp(baseUrl)

    // 跨重启身份稳定：同一 DATA_DIR 再启动一次，node.id 必须不变。
    await stopServer(child)
    child = startServer({ main: mainPath, port, dataDir })
    await checkAsync('重启后 node.id 不变（身份持久化）', async () => {
      await waitForHealth(baseUrl, child)
      const response = await fetch(baseUrl + WELL_KNOWN)
      assert(response.status === 200, `重启后发现端点状态码 ${response.status}。`)
      const body = await response.json()
      assert(body.node && body.node.id === discovery.node.id, `重启后 node.id 由 ${discovery.node.id} 变为 ${body.node?.id}。`)
      return { nodeId: body.node.id }
    })
  } catch (error) {
    checks.push({ name: '验收流程', ok: false, error: error.message })
  } finally {
    await stopServer(child)
    await rm(dataDir, { recursive: true, force: true })
    result.ok = checks.length > 0 && checks.every((entry) => entry.ok)
    result.checks = checks
    result.failures = checks.filter((entry) => !entry.ok)
    result.durationMs = Date.now() - startedAt
    if (discovery) result.node = discovery.node
    if (logs.length > 0) result.serverLogs = logs.slice(-20)
  }

  if (!result.ok) {
    result.note = '若当前工作树尚未合并 B（服务端）的 v2 实现，protocol:2 / 无扁平字段 / /v1/config 等断言失败是预期的；请合并后复跑。'
  }
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.ok ? 0 : 1
}

await main()
