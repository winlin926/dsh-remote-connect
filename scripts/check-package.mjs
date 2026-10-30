import { readFileSync } from 'node:fs'
// npm 10 prints an array of packages, npm 11 an object keyed by package name.
const packed = JSON.parse(readFileSync(process.argv[2] || '.qa/pack-manifest.json', 'utf8'))
const manifest = Array.isArray(packed) ? packed[0] : Object.values(packed)[0]
const paths = new Set(manifest.files.map(file => file.path))
for (const path of ['lib/index.js', 'lib/client.js', 'lib/types/index.d.ts', 'cordis.patch.yml', 'README.md']) {
  if (!paths.has(path)) throw new Error(`Missing package file: ${path}`)
}
for (const path of paths) {
  if (/^(\.qa|scripts|tests|docs|node_modules)\//.test(path) || /\.npmrc$/.test(path)) throw new Error(`Private or development file packaged: ${path}`)
  if (/^lib\/(remote|style)/.test(path)) throw new Error(`Retired remote UI asset packaged: ${path}`)
}
const expected = JSON.parse(readFileSync('package.json', 'utf8'))
if (manifest.name !== expected.name || manifest.version !== expected.version) throw new Error('Unexpected package identity')
if (paths.has('docs/ui-spec.md') || paths.has('docs/features.md')) throw new Error('Development documentation packaged')
const dependencies = Object.keys(expected.dependencies).join(' ')
if (dependencies.includes('dsh-web-frontend')) throw new Error('The package must not ship its own copy of the DSH frontend')
console.log(`Package verified: ${manifest.filename}; ${paths.size} files; private QA files excluded`)
