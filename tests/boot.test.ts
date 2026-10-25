import { expect, it } from 'vitest'
import { injectBoot } from '../src/boot.js'
import { localFilePath } from '../src/local-file.js'

const page = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>DeepSeek Harness</title></head><body><div id="root"></div></body></html>'

it('runs the remote boot script only after the viewport meta', () => {
  const html = injectBoot(page)
  const viewport = html.indexOf('name="viewport"')
  const script = html.indexOf('<script>')
  const title = html.indexOf('<title>')
  expect(viewport).toBeGreaterThan(0)
  expect(script).toBeGreaterThan(viewport)
  expect(title).toBeGreaterThan(script)
  expect(html).toContain('__DSH_REMOTE_CONTROL__')
  expect(injectBoot('<head><title>x</title></head>')).toMatch(/^<head><meta name="viewport" content="width=device-width, initial-scale=1"><script>/)
})

it('converts local file links to computer paths without losing Unix roots', () => {
  expect(localFilePath('file:///C:/Users/lenovo/Documents/a%20b.html')).toBe('C:/Users/lenovo/Documents/a b.html')
  expect(localFilePath('file:///home/user/workspace/index.html')).toBe('/home/user/workspace/index.html')
  expect(localFilePath('file://server/share/index.html')).toBeUndefined()
  expect(localFilePath('file:///C:/workspace/../secret.html')).toBe('C:/secret.html')
  expect(localFilePath('file:///C:/bad%ZZ.html')).toBeUndefined()
  expect(localFilePath('https://example.com/index.html')).toBeUndefined()
})
