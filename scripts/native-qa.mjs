// Acceptance for the phone experience: after pairing, the phone must run the Host's own web app,
// not a copy the plugin ships. Real isolated DSH Host, deterministic QA model, no user data.
import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'

const connection = JSON.parse(readFileSync(process.env.DSH_QA_CONNECTION || '.qa/connection.json', 'utf8'))
const browser = await chromium.launch({ executablePath: process.env.DSH_QA_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true })
const failures = []
const check = (name, passed, detail) => { if (!passed) failures.push({ name, detail }) }

const local = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await local.goto(connection.url)
const manage = (action, fields = {}) => local.evaluate(async ({ action, fields }) => {
  const response = await fetch('/api/dsh-remote-connect/manage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...fields }) })
  return response.json()
}, { action, fields })

await manage('stop'); await local.waitForTimeout(150)
await manage('preferences', { mode: 'lan' })
const started = await manage('start')
check('gateway starts', started?.enabled === true && started?.links?.length > 0, JSON.stringify(started?.error))

// The pairing page probes the panel endpoint on purpose and reads its 403 as "not paired yet",
// so nothing is collected until the phone has actually been let in.
const errors = []
let watching = false
const record = text => { if (watching) errors.push(text) }
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 })
const mobile = await context.newPage()
mobile.on('pageerror', error => record(`pageerror: ${error.message}`))
mobile.on('console', message => { if (message.type() === 'error') record(`console: ${message.text()} @ ${message.location().url}`) })
mobile.on('requestfailed', request => record(`requestfailed ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`))
mobile.on('response', response => { if (response.status() >= 400) record(`${response.request().method()} ${new URL(response.url()).pathname} HTTP ${response.status()}`) })

await mobile.goto(started.links[0].url)
await mobile.getByText('等待电脑确认，请查看本机远程控制面板').waitFor({ timeout: 20000 })
const pending = (await manage('status')).requests
check('pairing request reaches the computer', pending.length === 1, JSON.stringify(pending))
await manage('approve', { id: pending[0].id })
await mobile.waitForURL(url => url.pathname === '/', { timeout: 20000 })
watching = true
await mobile.waitForTimeout(5000)

const page = await mobile.evaluate(() => ({
  bootTag: !!document.querySelector('script[src="/rc/boot.js"]'),
  remoteFlag: window.__DSH_REMOTE_CONTROL__ === true,
  hostBoot: !!window.__DSH_BOOT__,
  moduleLoader: !!window.__ModuleLoader__,
  mounted: (document.querySelector('#root')?.children.length ?? 0) > 0,
  shellScripts: [...document.querySelectorAll('script[src]')].map(script => script.getAttribute('src')).filter(src => /assets\/index-/.test(src ?? '')),
  lang: document.documentElement.lang,
  viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '',
  themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? '',
  mobileStyle: !!document.querySelector('style#dsh-rc-mobile'),
}))
check('the boot script is served same-origin', page.bootTag && page.remoteFlag, JSON.stringify(page))
check('the Host page provides its boot payload', page.hostBoot && page.moduleLoader, JSON.stringify(page))
check('the Host app mounts on the phone', page.mounted, JSON.stringify(page))
check('the shell is the Host build', page.shellScripts.length === 1, JSON.stringify(page.shellScripts))
check('the page speaks Chinese', page.lang === 'zh-CN', page.lang)
check('the mobile shim sets the keyboard policy and form size', page.mobileStyle && page.viewport.includes('interactive-widget=resizes-content'), JSON.stringify({ viewport: page.viewport }))
check('the browser chrome follows the theme', /rgb|#/.test(page.themeColor), page.themeColor)
check('no failed requests or console errors after pairing', errors.length === 0, JSON.stringify(errors.slice(0, 6)))

// A fresh Host shows its own welcome dialog; dismissing it is part of reaching the real page.
const welcome = mobile.getByRole('button', { name: '继续', exact: true }).first()
if (await welcome.count()) { await welcome.click().catch(() => {}); await mobile.waitForTimeout(1200) }
const layout = await mobile.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  innerWidth,
  composer: !!document.querySelector('textarea, [contenteditable="true"]'),
}))
check('no horizontal overflow on a phone', layout.scrollWidth <= layout.innerWidth + 1, JSON.stringify(layout))
check('the composer is reachable', layout.composer, JSON.stringify(layout))

// The decisive check: the phone holds a real conversation through the Host's own composer.
const composer = mobile.locator('[contenteditable="true"]').first()
await composer.click()
await mobile.keyboard.type('手机原生界面验证', { delay: 15 })
await mobile.getByRole('button', { name: '发送消息', exact: true }).click()
let replied = true
await mobile.getByText('远程链路验证通过', { exact: false }).first().waitFor({ timeout: 45000 }).catch(() => { replied = false })
check('a message sent from the phone gets a reply', replied)
check('the plugin panel entry loads beside the Host sidebar', (await mobile.getByRole('button', { name: '远程控制', exact: true }).count()) > 0)

await mobile.screenshot({ path: '.qa/native-mobile.png', fullPage: false })
await manage('stop')
await browser.close()
console.log(JSON.stringify({ passed: failures.length === 0, page, failures }, null, 2))
if (failures.length) process.exit(1)
