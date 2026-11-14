import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const run = join(root, '.qa', 'smoke'), home = join(run, 'home'), profile = join(home, 'profiles', 'web')
if (existsSync(run)) throw new Error('The isolated .qa/smoke directory already exists; stop its Host and remove only that directory before starting again.')
mkdirSync(profile, { recursive: true })
const { name } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const link = join(profile, 'node_modules', name)
mkdirSync(dirname(link), { recursive: true }); symlinkSync(root, link, 'junction')
const workspace = join(run, 'workspace'); mkdirSync(workspace)
const preview = join(workspace, 'preview.html'), text = join(workspace, 'preview.txt')
writeFileSync(preview, '<!doctype html><meta charset="utf-8"><title>Remote preview</title><h1>隔离文件预览通过</h1>')
writeFileSync(text, '隔离文本预览通过')
writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-remote-qa', private: true, dependencies: { [name]: 'link:' + root }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', name] } } }))
writeFileSync(join(profile, 'cordis.yml'), '[]\n')
writeFileSync(join(profile, 'cordis.patch.yml'), `- id: workspace-controller\n  config:\n    documentsDirectory: '${workspace.replaceAll('\\', '/')}'\n`)
const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')
const child = spawn(process.execPath, [cli, '--profile', 'web', '--no-open', '--port', '0'], { cwd: run, env: { ...process.env, DSH_HOME: home, DSH_RC_CERTIFICATE_DIR: join(run, 'certificates'), DSH_TELEMETRY_DISABLED: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let log = '', ready = false
const startup = setTimeout(() => { console.error('Isolated Host startup timed out.'); child.kill() }, 60000)
for (const output of [child.stdout, child.stderr]) output.on('data', data => {
  log += String(data)
  writeFileSync(join(run, 'host.log'), log, { mode: 0o600 })
  const match = log.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s\u001b]*/)
  if (match && !ready) {
    ready = true; clearTimeout(startup)
    writeFileSync(join(run, 'connection.json'), JSON.stringify({ url: match[0], pid: child.pid, preview, text }), { mode: 0o600 })
    console.log(`Isolated DSH ready: ${new URL(match[0]).origin}; run pnpm qa:browser in another terminal. Ctrl+C stops it and removes its private data.`)
  }
})
child.on('error', error => console.error(error.message))
child.on('close', code => {
  clearTimeout(startup)
  if (!ready) console.error(log.slice(-4000).replace(/([?&]token=)[^\s&]+/g, '$1[redacted]'))
  if (realpathSync(run) !== run || realpathSync(link) !== realpathSync(root)) throw new Error('Unexpected isolated QA cleanup target')
  unlinkSync(link)
  rmSync(run, { recursive: true, force: true })
  console.log('Isolated Host stopped; private QA data removed.')
  process.exitCode = code ?? 0
})
process.on('SIGINT', () => child.kill())
process.on('SIGTERM', () => child.kill())
