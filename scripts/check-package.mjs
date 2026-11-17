import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const expected = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const server = JSON.parse(readFileSync(join(root, 'remote-server', 'package.json'), 'utf8'))
if (server.version !== expected.version) throw new Error('Plugin and service-node versions must match')
const entries = ['lib/index.js', 'lib/client.js']
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function checkFiles(paths) {
  for (const path of [...entries, 'lib/types/index.d.ts', 'cordis.patch.yml', 'assets/logo.png', 'locale/en.json', 'locale/zh.json', 'README.md', 'LICENSE', 'package.json']) {
    if (!paths.has(path)) throw new Error(`Missing package file: ${path}`)
  }
  for (const path of paths) {
    if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '..' || part === '.')) throw new Error(`Invalid package path: ${path}`)
    if (!/^(package\.json|LICENSE|README(\.[a-z-]+)?\.md|cordis\.patch\.yml|assets\/logo\.png)$/.test(path) && !/^locale\/[a-z]{2}(-[A-Z]{2})?\.json$/.test(path) && !/^lib\/[^/]+\.js$/.test(path) && !/^lib\/types\/.+\.d\.ts$/.test(path)) throw new Error(`Unexpected package file: ${path}`)
    if (path.startsWith('lib/types/') && path.endsWith('.d.ts') && !existsSync(join(root, path.replace('lib/types/', 'src/').replace(/\.d\.ts$/, '.ts')))) throw new Error(`Declaration without source: ${path}`)
  }
  if (Object.keys(expected.dependencies).includes('dsh-web-frontend')) throw new Error('The package must not ship its own copy of the DSH frontend')
}

export function entryHashes(directory) {
  return Object.fromEntries(entries.map(path => [path, sha256(readFileSync(join(directory, path)))]))
}

export function inspectPackage(tarball) {
  if (!isAbsolute(tarball) || !tarball.endsWith('.tgz')) throw new Error('Package must be an absolute .tgz path')
  const archive = readFileSync(tarball)
  const tar = args => {
    const result = spawnSync('tar', args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Cannot read package archive: ${result.stderr.toString().trim()}`)
    return result.stdout
  }
  const paths = new Set(tar(['-tf', tarball]).toString('utf8').trim().split(/\r?\n/).filter(path => !path.endsWith('/')).map(path => {
    if (!path.startsWith('package/')) throw new Error(`Unexpected archive root: ${path}`)
    return path.slice('package/'.length)
  }))
  checkFiles(paths)
  const packed = JSON.parse(tar(['-xOf', tarball, 'package/package.json']).toString('utf8'))
  for (const field of ['name', 'version', 'main', 'exports', 'dependencies', 'peerDependencies']) {
    if (!isDeepStrictEqual(packed[field], expected[field])) throw new Error(`Package ${field} differs from this checkout`)
  }
  const hashes = Object.fromEntries(entries.map(path => [path, sha256(tar(['-xOf', tarball, 'package/' + path]))]))
  if (!isDeepStrictEqual(hashes, entryHashes(root))) throw new Error('Packed runtime entries differ from this checkout; build and pack the same candidate once')
  return { filename: basename(tarball), name: packed.name, version: packed.version, sha256: sha256(archive), entries: hashes, files: paths.size }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.argv[2] || join(root, '.qa', 'pack-manifest.json')
  if (input.endsWith('.tgz')) console.log(JSON.stringify(inspectPackage(input), null, 2))
  else {
    const packed = JSON.parse(readFileSync(input, 'utf8'))
    const manifest = Array.isArray(packed) ? packed[0] : packed.files ? packed : Object.values(packed)[0]
    checkFiles(new Set(manifest.files.map(file => file.path)))
    if (manifest.name !== expected.name || manifest.version !== expected.version) throw new Error('Unexpected package identity')
    console.log(`Package verified: ${manifest.filename}; ${manifest.files.length} files; private QA files excluded`)
  }
}
