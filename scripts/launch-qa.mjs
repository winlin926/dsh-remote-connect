import { spawn, spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createSecureContext } from 'node:tls'
import { domainToASCII, fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { entryHashes, inspectPackage } from './check-package.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: { package: { type: 'string' }, 'tls-hostname': { type: 'string' }, 'tls-cert': { type: 'string' }, 'tls-key': { type: 'string' }, 'gateway-port': { type: 'string' }, 'run-directory': { type: 'string' } } })
const port = values['gateway-port'] === undefined ? undefined : Number(values['gateway-port'])
if (port !== undefined && (!/^\d+$/.test(values['gateway-port']) || !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('--gateway-port must be an integer from 1 to 65535')
const tlsInputs = ['tls-hostname', 'tls-cert', 'tls-key']
let lanTls
if (tlsInputs.some(name => values[name] !== undefined)) {
  if (tlsInputs.some(name => !values[name]) || port === undefined) throw new Error('HTTPS requires --tls-hostname, --tls-cert, --tls-key and --gateway-port together')
  const hostname = domainToASCII(values['tls-hostname']).toLowerCase()
  if (!hostname || hostname.length > 253 || isIP(hostname) || !hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('--tls-hostname must be a DNS hostname without a scheme, port or path')
  for (const name of ['tls-cert', 'tls-key']) if (!isAbsolute(values[name]) || !statSync(values[name]).isFile()) throw new Error(`--${name} must be an absolute file path`)
  const cert = readFileSync(values['tls-cert']), key = readFileSync(values['tls-key'])
  createSecureContext({ cert, key })
  const certificate = new X509Certificate(cert)
  if (!certificate.checkHost(hostname) || Date.now() < Date.parse(certificate.validFrom) || Date.now() >= Date.parse(certificate.validTo)) throw new Error('TLS certificate must be current and cover --tls-hostname')
  lanTls = { hostname, certFile: realpathSync(values['tls-cert']), keyFile: realpathSync(values['tls-key']) }
}
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const artifact = values.package ? { kind: 'package', ...inspectPackage(values.package) } : { kind: 'link', name: pkg.name, version: pkg.version, entries: entryHashes(root) }
const require = createRequire(import.meta.url)
const cliPackage = require.resolve('@deepseek-ai/dsh/package.json')
const hostVersion = JSON.parse(readFileSync(cliPackage, 'utf8')).version
if (hostVersion !== pkg.devDependencies['@deepseek-ai/dsh']) throw new Error('QA Host differs from the pinned DSH development version')
const cli = join(dirname(cliPackage), 'lib', 'bin.js')
const qaRoot = join(root, '.qa')
mkdirSync(qaRoot, { recursive: true })
if (lstatSync(qaRoot).isSymbolicLink() || realpathSync(qaRoot) !== join(realpathSync(root), '.qa')) throw new Error('Unexpected QA root')
const runName = values['run-directory'] ?? 'smoke'
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(runName)) throw new Error('--run-directory must be a simple name within .qa')
const run = join(qaRoot, runName), home = join(run, 'home'), profile = join(home, 'profiles', 'web')
try { lstatSync(run); throw new Error(`The isolated .qa/${runName} directory already exists; stop its Host and remove only that directory before starting again.`) } catch (error) { if (error.code !== 'ENOENT') throw error }
const link = join(profile, 'node_modules', pkg.name)
let created = false, linked = false
function cleanup() {
  if (!created) return
  if (lstatSync(run).isSymbolicLink() || realpathSync(run) !== join(realpathSync(qaRoot), runName)) throw new Error('Unexpected isolated QA cleanup target')
  if (linked && existsSync(link)) {
    if (!lstatSync(link).isSymbolicLink() || realpathSync(link) !== realpathSync(root)) throw new Error('Unexpected isolated QA package link')
    unlinkSync(link)
  }
  rmSync(run, { recursive: true, force: true })
  created = false
}
try {
  mkdirSync(run); created = true
  mkdirSync(profile, { recursive: true })
  const dependencies = { [pkg.name]: values.package ? 'file:' + values.package.replaceAll('\\', '/') : 'link:' + root }
  const overrides = {}
  if (values.package) {
    if (!process.env.npm_execpath || !isAbsolute(process.env.npm_execpath)) throw new Error('Run package QA through pnpm qa:host --package <absolute.tgz>')
    for (const name of [...Object.keys(pkg.peerDependencies), ...Object.keys(pkg.dependencies)]) {
      const version = JSON.parse(readFileSync(require.resolve(name + '/package.json'), 'utf8')).version
      overrides[name] = version
      if (name in pkg.peerDependencies) dependencies[name] = version
    }
  }
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-remote-qa', private: true, dependencies, ...(values.package ? { pnpm: { overrides } } : {}), dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', pkg.name] } } }))
  if (values.package) {
    const pnpm = process.env.npm_execpath, native = process.platform === 'win32' && /\.exe$/i.test(pnpm)
    const args = ['install', '--offline', '--ignore-scripts', '--ignore-workspace', '--no-frozen-lockfile', '--config.auto-install-peers=false']
    const installed = spawnSync(native ? pnpm : process.execPath, native ? args : [pnpm, ...args], { cwd: profile, env: process.env, windowsHide: true, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024 })
    if (installed.error) throw installed.error
    if (installed.status !== 0) throw new Error('Isolated package install failed:\n' + (installed.stdout + installed.stderr).slice(-6000))
    const installedPath = realpathSync(link), local = relative(realpathSync(profile), installedPath)
    if (local.startsWith('..') || isAbsolute(local) || JSON.stringify(entryHashes(installedPath)) !== JSON.stringify(artifact.entries)) throw new Error('Installed candidate entries do not match the confined package artifact')
    console.log(`Installed isolated package ${artifact.filename}; SHA-256 ${artifact.sha256}`)
  } else {
    mkdirSync(dirname(link), { recursive: true }); symlinkSync(root, link, 'junction'); linked = true
  }
  const workspace = join(run, 'workspace'); mkdirSync(workspace)
  const preview = join(workspace, 'preview.html'), text = join(workspace, 'preview.txt')
  writeFileSync(preview, '<!doctype html><meta charset="utf-8"><title>Remote preview</title><h1>隔离文件预览通过</h1>')
  writeFileSync(text, '隔离文本预览通过')
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const pluginId = /\bid:\s*([^\s#]+)/.exec(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'))?.[1]
  if (!pluginId) throw new Error('Plugin bundle has no row id')
  const pluginConfig = { ...(port === undefined ? {} : { gatewayPort: port }), ...(lanTls ? { lanTls } : {}) }
  writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([{ id: 'workspace-controller', config: { documentsDirectory: workspace.replaceAll('\\', '/') } }, { id: pluginId, config: pluginConfig }]))
  const child = spawn(process.execPath, [cli, '--profile', 'web', '--no-open', '--port', '0'], { cwd: run, env: { ...process.env, DSH_HOME: home, DSH_RC_CERTIFICATE_DIR: join(run, 'certificates'), DSH_TELEMETRY_DISABLED: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = '', ready = false
  const startup = setTimeout(() => { console.error('Isolated Host startup timed out.'); child.kill() }, 60000)
  for (const output of [child.stdout, child.stderr]) output.on('data', data => {
    log += String(data)
    writeFileSync(join(run, 'host.log'), log, { mode: 0o600 })
    const match = log.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s\u001b]*/)
    if (match && !ready) {
      ready = true; clearTimeout(startup)
      writeFileSync(join(run, 'connection.json'), JSON.stringify({ url: match[0], pid: child.pid, preview, text, artifact, hostVersion, runDirectory: runName, ...(lanTls ? { tls: { hostname: lanTls.hostname, gatewayPort: port } } : {}) }), { mode: 0o600 })
      console.log(`Isolated DSH ready: ${new URL(match[0]).origin}; run pnpm qa:browser -- --run-directory ${runName} in another terminal. Ctrl+C stops it and removes its private data.`)
    }
  })
  child.on('error', error => console.error(error.message))
  child.on('close', code => {
    clearTimeout(startup)
    if (!ready) console.error(log.slice(-4000).replace(/([?&]token=)[^\s&]+/g, '$1[redacted]'))
    cleanup()
    console.log('Isolated Host stopped; private QA data removed.')
    process.exitCode = code ?? 0
  })
  process.on('SIGINT', () => child.kill())
  process.on('SIGTERM', () => child.kill())
} catch (error) {
  cleanup()
  throw error
}
