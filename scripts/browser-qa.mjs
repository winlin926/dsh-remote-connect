import { readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'

const moduleUrl = new URL(import.meta.url)
const { values } = parseArgs({ options: { 'run-directory': { type: 'string' } }, strict: false, allowPositionals: true })
const runDirectory = moduleUrl.searchParams.get('run-directory') || values['run-directory'] || 'smoke'
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(runDirectory)) throw new Error('Run directory must be a simple name within .qa')

if (typeof taskSpace !== 'function') {
  moduleUrl.searchParams.set('run-directory', runDirectory)
  const entry = "await import('" + moduleUrl.href.replaceAll("'", '%27') + "')"
  const result = spawnSync('ego-browser.exe', ['nodejs', '-e', entry], { stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} else {
  const run = join(dirname(fileURLToPath(moduleUrl)), '..', '.qa', runDirectory)
  const connection = JSON.parse(readFileSync(join(run, 'connection.json'), 'utf8'))
  if (!connection.artifact?.entries || !connection.hostVersion) throw new Error('QA connection is missing its artifact or Host manifest')
  for (const name of ['desktop-light', 'desktop-dark', 'phone-320-light', 'phone-320-dark', 'phone-390-light', 'phone-390-dark']) rmSync(join(run, name + '.png'), { force: true })
  const task = await taskSpace('DSH remote plugin smoke')
  for (const tab of await task.tabs()) if (tab.label && tab.label !== 'p1' && tab.openedBy === 'agent') await task.page(tab.label).close()
  const desktop = task.page('p1'), results = [], captureWarnings = [], captures = []
  const cacheRuns = []
  const originalCookies = (await desktop.cdp('Network.getCookies', { urls: [connection.url] })).cookies
  const managedOrigins = new Set([new URL(connection.url).origin])
  const manage = async (action, fields = {}) => {
    const response = await desktop.fetch('/api/dsh-remote-connect/manage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...fields }) })
    assert.equal(response.status, 200, `management ${action} failed`)
    return JSON.parse(response.body)
  }
  const clickButton = async (page, name) => {
    await page.cdp('Page.bringToFront')
    await page.evaluate(name => {
      const button = [...document.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') || node.textContent.trim()) === name && node.getBoundingClientRect().width)
      if (!button) throw new Error('Missing visible button: ' + name)
      button.click()
    }, name)
  }
  const dismissOnboarding = async page => {
    await page.cdp('Page.bringToFront')
    await page.waitForSelector('.dsrc-entry', { state: 'attached', timeout: 20000 })
    for (let step = 0; step < 3; step++) {
      await page.waitForSelector('dialog[open] button, [role="dialog"] button[aria-label="Close"], [role="dialog"] button[aria-label="关闭"]', { state: 'visible', timeout: 5000 }).catch(() => {})
      const actions = await page.evaluate(() => [...document.querySelectorAll('dialog[open] button,[role="dialog"] button')].filter(button => button.getBoundingClientRect().width).map(button => ({ name: button.getAttribute('aria-label') || button.textContent.trim(), text: button.closest('dialog,[role="dialog"]').innerText })))
      const action = actions.find(item => /^(继续|Continue|关闭|Close)$/.test(item.name))
      if (!action) break
      await page.evaluate(name => [...document.querySelectorAll('dialog[open] button,[role="dialog"] button')].find(button => (button.getAttribute('aria-label') || button.textContent.trim()) === name && button.getBoundingClientRect().width)?.click(), action.name)
      await page.waitForFunction(text => ![...document.querySelectorAll('dialog[open],[role="dialog"]')].some(dialog => dialog.getBoundingClientRect().width && dialog.innerText === text), action.text, { timeout: 5000 })
    }
  }
  const pluginTraffic = async page => {
    const events = await page.events()
    const requestById = new Map(), responseById = new Map(), finishedById = new Map(), failed = new Set(), cached = new Set()
    for (const event of events) {
      if (event.method === 'Network.requestWillBeSent') requestById.set(event.params.requestId, event.params.request.url)
      else if (event.method === 'Network.responseReceived') responseById.set(event.params.requestId, event.params)
      else if (event.method === 'Network.loadingFinished') finishedById.set(event.params.requestId, event.params.encodedDataLength)
      else if (event.method === 'Network.loadingFailed') failed.add(event.params.requestId)
      else if (event.method === 'Network.requestServedFromCache') cached.add(event.params.requestId)
    }
    const resources = [...requestById].filter(([, url]) => new URL(url).pathname.startsWith('/plugins/')).map(([id, url]) => {
      const response = responseById.get(id)?.response
      return {
      url, status: response?.status ?? null,
      cacheControl: response?.headers['cache-control'] || '',
      disk: response?.fromDiskCache === true,
      cached: cached.has(id) || response?.fromPrefetchCache === true,
      bytes: finishedById.get(id) ?? 0,
      complete: finishedById.has(id), failed: failed.has(id),
    }
    })
    const largest = resources.reduce((result, row) => row.bytes > (result?.bytes ?? 0) ? row : result, undefined)
    return {
      observedEvents: events.length, requests: resources.length, responses: resources.filter(row => row.status !== null).length,
      completed: resources.filter(row => row.complete).length, failed: resources.filter(row => row.failed).length,
      networkBytes: resources.reduce((total, row) => total + row.bytes, 0),
      diskHits: resources.filter(row => row.disk).length, cacheHits: resources.filter(row => row.cached || row.disk).length,
      incomplete: resources.filter(row => row.status !== null && !row.complete && !row.failed).length,
      statuses: resources.filter(row => row.status !== 200).map(row => ({ url: row.url, status: row.status })),
      largest: largest ? { revision: new URL(largest.url).searchParams.get('rev'), bytes: largest.bytes } : null,
      resources: resources.map(({ url, bytes, status, disk, cached, complete, failed }) => ({ revision: new URL(url).searchParams.get('rev'), bytes, status, disk, cached, complete, failed })),
      websocketUrls: events.filter(event => event.method === 'Network.webSocketCreated').map(event => event.params.url).filter(url => url.startsWith('wss:'))
    }
  }
  const assertLargestBatchReused = (phase, visit, first) => {
    assert.ok(first.largest?.revision && first.largest.bytes > 1024 * 1024, 'First visit did not fetch a large revisioned plugin batch')
    const matching = visit.resources.filter(row => row.revision === first.largest.revision)
    const transferred = matching.reduce((total, row) => total + row.bytes, 0)
    assert.ok(transferred < first.largest.bytes / 2, `${phase} downloaded the largest plugin batch again (${transferred}/${first.largest.bytes} bytes)`)
  }
  const awaitApplication = async page => page.waitForFunction(() => {
    const root = document.getElementById('root')
    return !!root?.querySelector('[data-sidebar-drawer]')
      && !root.innerText.includes('Loading plugins')
      && !root.querySelector('[data-dsh-boot]')
  }, undefined, { timeout: 30000 })
  const applicationReadyMs = async (page, startedAt) => {
    await awaitApplication(page)
    return Date.now() - startedAt
  }
  const layout = async (page, name, width = 1280) => {
    const { windowId, bounds } = await task.cdp('Browser.getWindowForTarget', { targetId: page.targetId })
    if (bounds.windowState === 'minimized') await task.cdp('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    await page.cdp('Page.bringToFront')
    await page.cdp('Emulation.setDeviceMetricsOverride', { width, height: width === 1280 ? 900 : 844, mobile: width < 560, deviceScaleFactor: 1 })
    await page.waitForFunction(() => [...document.querySelectorAll('.dsrc-dialog[open]')].every(panel => panel.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running' || !Number.isFinite(animation.effect.getComputedTiming().endTime))), undefined, { timeout: 5000 })
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector('.dsrc-dialog[open]'), box = panel?.getBoundingClientRect()
      const close = panel?.querySelector('.dsrc-close'), style = close && getComputedStyle(close)
      const luminance = value => value.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0)
      const foreground = style ? luminance(style.color) : 0, background = style ? luminance(style.backgroundColor) : 0
      return { closeContrast: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05), width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1, inside: !!box && box.x >= -1 && box.right <= innerWidth + 1, entries: document.querySelectorAll('.dsrc-entry').length }
    })
    assert.ok(width === 1280 ? geometry.width >= 960 : Math.abs(geometry.width - width) <= 1, name + ': viewport changed')
    assert.equal(geometry.overflow, false, name + ': horizontal overflow')
    assert.equal(geometry.inside, true, name + ': dialog outside viewport')
    assert.equal(geometry.entries, 1, name + ': duplicate entry')
    assert.ok(geometry.closeContrast >= 4.5, name + ': close button contrast')
    if (!captureWarnings.length) {
      try { captures.push(await page.screenshot({ path: join(run, name + '.png'), raw: true })) }
      catch (error) {
        if (!/captureScreenshot|window is minimized/.test(error.message)) throw error
        captureWarnings.push({ name, error: error.message })
        console.warn('Screenshot capture unavailable; remaining captures skipped.')
      }
    }
    results.push(name)
    console.log('PASS', name)
  }
  let phone, passed = false
  try {
    await desktop.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, mobile: false, deviceScaleFactor: 1 })
    await desktop.goto(connection.url)
    console.log(await desktop.snapshot())
    await dismissOnboarding(desktop)
    await manage('stop')
    await manage('preferences', { autoStart: false, mode: 'lan', publicUrl: '' })
    if ((await manage('status')).devices.length) {
      await manage('revokeAll')
      await desktop.waitForFunction(async () => !(await (await fetch('/api/dsh-remote-connect/manage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"status"}' })).json()).devices.length, undefined, { timeout: 5000 })
    }
    await desktop.click('loc=role:button[name="远程控制"]', { label: '打开远程连接面板' })
    await desktop.waitForSelector('loc=role:button[name="开启远程连接"]', { state: 'visible' })
    await desktop.click('loc=role:button[name="开启远程连接"]', { label: '开启隔离局域网连接' })
    await desktop.waitForSelector('loc=role:button[name="关闭远程连接"]', { state: 'visible' })
    const started = await manage('status')
    const gatewayOrigin = new URL(started.links[0].url).origin
    managedOrigins.add(gatewayOrigin)
    const link = started.links[0].url
    const knownCookies = new Set(originalCookies.map(cookie => `${cookie.name}\0${cookie.domain}\0${cookie.path}`))
    const additionalCookies = (await desktop.cdp('Network.getCookies', { urls: [...managedOrigins] })).cookies
    for (const cookie of additionalCookies) {
      const key = `${cookie.name}\0${cookie.domain}\0${cookie.path}`
      if (!knownCookies.has(key)) originalCookies.push(cookie)
    }
    if (connection.tls) {
      assert.ok(Number.isInteger(started.gatewayPort) && started.gatewayPort === connection.tls.gatewayPort, 'TLS gateway port changed')
      assert.ok(started.links.every(item => new URL(item.url).hostname === connection.tls.hostname && new URL(item.url).protocol === 'https:'), 'TLS pairing links must use the trusted DNS name')
      assert.equal(started.lanTls?.origin, gatewayOrigin, 'TLS status must advertise the active LAN HTTPS origin')
      assert.ok(!started.lanTls?.error, 'TLS status reported an error')
    }
    results.push('production management and LAN startup')
    await layout(desktop, 'desktop-light')
    await desktop.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
    await layout(desktop, 'desktop-dark')
    phone = await task.newPage()
    await phone.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, mobile: true, deviceScaleFactor: 1 })
    await phone.cdp('Emulation.setTouchEmulationEnabled', { enabled: true })
    await phone.cdp('Network.enable')
    await phone.events()
    await phone.goto(link)
    await phone.waitForFunction(() => document.getElementById('state')?.textContent.includes('等待电脑确认'), undefined, { timeout: 10000 })
    await desktop.waitForSelector('.dsrc-prompt[open]', { state: 'visible', timeout: 10000 })
    await desktop.click('.dsrc-prompt[open] button.dsrc-primary', { label: '批准隔离手机配对' })
    const firstReadyStartedAt = Date.now()
    await phone.waitForURL(url => new URL(url).pathname === '/', { timeout: 15000 })
    const firstReadyMs = await applicationReadyMs(phone, firstReadyStartedAt)
    await dismissOnboarding(phone)
    const firstVisit = await pluginTraffic(phone)
    assert.ok(firstVisit.requests > 0 && firstVisit.networkBytes > 0, 'First visit did not fetch measurable plugin resources')
    assert.ok(firstVisit.incomplete === 0 && firstVisit.failed === 0, 'First-visit plugin network events were incomplete or failed')
    if (connection.tls) {
      const security = await phone.evaluate(() => ({ protocol: location.protocol, secure: isSecureContext, host: location.host }))
      assert.deepEqual(security, { protocol: 'https:', secure: true, host: `${connection.tls.hostname}:${connection.tls.gatewayPort}` }, 'LAN page must use the validated TLS origin')
      assert.ok(firstVisit.websocketUrls.length > 0, 'No WSS connection was observed')
      results.push('trusted LAN HTTPS, secure context, and WSS carrier')
    } else {
      const security = await phone.evaluate(() => ({ protocol: location.protocol, secure: isSecureContext }))
      assert.equal(security.secure, security.protocol === 'https:')
    }
    cacheRuns.push({ phase: 'first-visit', readyMs: firstReadyMs, ...firstVisit })
    results.push('QR approval and current Host mobile application ready')
    console.log('PASS pairing and Host application ready')
    const revisitStartedAt = Date.now()
    await phone.reload()
    const revisitReadyMs = await applicationReadyMs(phone, revisitStartedAt)
    const sameTabVisit = await pluginTraffic(phone)
    assertLargestBatchReused('Same-tab revisit', sameTabVisit, firstVisit)
    cacheRuns.push({ phase: 'same-tab-revisit', readyMs: revisitReadyMs, ...sameTabVisit })
    await phone.close()
    phone = await task.newPage()
    await phone.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, mobile: true, deviceScaleFactor: 1 })
    await phone.cdp('Emulation.setTouchEmulationEnabled', { enabled: true })
    await phone.cdp('Network.enable')
    const reopenStartedAt = Date.now()
    await phone.goto(new URL('/', started.links[0].url).href)
    const reopenReadyMs = await applicationReadyMs(phone, reopenStartedAt)
    const reopenedVisit = await pluginTraffic(phone)
    assertLargestBatchReused('Tab-close reopen', reopenedVisit, firstVisit)
    cacheRuns.push({ phase: 'tab-close-reopen', readyMs: reopenReadyMs, ...reopenedVisit })
    if (connection.tls) assert.ok(cacheRuns.at(-1).websocketUrls.length > 0, 'WSS carrier was not restored after tab re-entry')
    console.log('CACHE', JSON.stringify({ runs: cacheRuns, browserProcessRestart: 'manual' }))
    await desktop.cdp('Page.bringToFront')
    await desktop.waitForSelector('button:text-is("重命名")', { state: 'visible' })
    await desktop.click('button:text-is("重命名")', { label: '重命名隔离测试设备' })
    await desktop.fill('.dsrc-rename', '中文测试设备')
    await desktop.evaluate(() => document.querySelector('.dsrc-rename').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
    assert.equal(await desktop.evaluate(() => !!document.querySelector('.dsrc-rename')), true, 'IME Enter committed the name')
    await desktop.press('.dsrc-rename', 'Enter')
    await desktop.waitForFunction(() => [...document.querySelectorAll('.dsrc-device-name')].some(node => node.textContent.includes('中文测试设备')), undefined, { timeout: 10000 })
    results.push('composition Enter ignored; ordinary Enter saves')
    await manage('preferences', { publicUrl: 'https://smoke.example.com' })
    if (!await desktop.evaluate(() => document.querySelector('.dsrc-preferences')?.open)) await desktop.click('.dsrc-preferences > summary', { label: '展开连接设置' })
    await desktop.waitForSelector('.dsrc-domain-field input', { state: 'visible' })
    assert.equal(await desktop.evaluate(() => [...document.querySelectorAll('.dsrc-status-label')].some(node => node.textContent.includes('主机指纹'))), true, 'panel shows the host fingerprint')
    await desktop.evaluate(() => {
      if (navigator.clipboard) Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => { throw new Error('clipboard denied') } })
      document.execCommand = () => false
    })
    await desktop.click('.dsrc-pair-link button', { label: '验证链接复制失败反馈' })
    assert.equal(await desktop.evaluate(() => document.querySelector('.dsrc-copy-fallback')?.value), started.links[0].url)
    results.push('copy fallback preserves the requested pairing link')
    await desktop.evaluate(() => {
      const transport = window.__DSH_TRANSPORT__ ??= {}, original = transport.fetch ?? window.fetch
      const state = window.__qaPoll = { held: false, released: false, resume: null, restore: () => { transport.fetch = original } }
      transport.fetch = async (input, init) => {
        const response = await original(input, init)
        if (!state.held && JSON.parse(init?.body || '{}').action === 'status') {
          state.held = true
          await new Promise(resolve => { state.resume = () => { state.released = true; resolve() } })
        }
        return response
      }
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await desktop.waitForFunction(() => window.__qaPoll.held, undefined, { timeout: 5000 })
    await desktop.click('.dsrc-toggle input', { label: '验证轮询与操作顺序' })
    await desktop.waitForFunction(() => document.querySelector('.dsrc-toggle input')?.checked && !document.querySelector('.dsrc-toggle input')?.disabled, undefined, { timeout: 5000 })
    await desktop.evaluate(() => { window.__qaPoll.resume(); window.__qaPoll.restore() })
    await desktop.waitForFunction(() => window.__qaPoll.released, undefined, { timeout: 5000 })
    assert.equal(await desktop.evaluate(() => document.querySelector('.dsrc-toggle input')?.checked), true)
    await desktop.click('.dsrc-toggle input', { label: '恢复隔离自动开启设置' })
    results.push('late status response cannot overwrite a saved preference')
    const previewPath = '/rc/workspace-file?p=' + encodeURIComponent(connection.preview)
    const opened = await phone.fetch(previewPath)
    assert.equal(opened.status, 200)
    assert.ok(opened.body.includes('隔离文件预览通过'))
    const capability = opened.url
    const text = await phone.fetch('/rc/workspace-file?p=' + encodeURIComponent(connection.text))
    assert.equal(text.body, '隔离文本预览通过')
    results.push('sandboxed HTML and streamed text preview')
    const drawer = await phone.evaluate(() => [...document.querySelectorAll('button[aria-label]')].map(node => node.getAttribute('aria-label')).find(name => /^(打开侧边栏|Open sidebar)$/.test(name)))
    if (drawer) await clickButton(phone, drawer)
    await clickButton(phone, '远程控制')
    await phone.waitForSelector('.dsrc-dialog[open]', { state: 'visible', timeout: 10000 })
    for (const width of [320, 390]) {
      await phone.cdp('Emulation.setDeviceMetricsOverride', { width, height: 844, mobile: true, deviceScaleFactor: 1 })
      for (const theme of ['light', 'dark']) {
        await phone.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
        await layout(phone, `phone-${width}-${theme}`, width)
      }
    }
    const device = (await manage('status')).devices.find(row => row.name === '中文测试设备')
    await manage('revoke', { id: device.id })
    await phone.waitForFunction(() => !!document.getElementById('dsh-rc-disconnected'), undefined, { timeout: 10000 })
    assert.equal((await phone.fetch('/api/dsh-remote-connect/manage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"status"}' })).status, 403)
    assert.equal((await phone.fetch(new URL(capability).pathname)).status, 404)
    results.push('revocation blocks management and preview immediately')
    passed = true
    console.log(JSON.stringify({ passed, results, cacheRuns, browserProcessRestart: 'manual', captureWarnings, screenshots: captures }, null, 2))
  } finally {
    await manage('stop').catch(() => {})
    const current = (await desktop.cdp('Network.getCookies', { urls: [...managedOrigins] })).cookies
    for (const cookie of current) {
      if (!originalCookies.some(original => original.name === cookie.name && original.domain === cookie.domain && original.path === cookie.path)) await desktop.cdp('Network.deleteCookies', { name: cookie.name, domain: cookie.domain, path: cookie.path })
    }
    if (originalCookies.length) await desktop.cdp('Network.setCookies', { cookies: originalCookies.map(({ name, value, domain, path, secure, httpOnly, sameSite, expires }) => ({ name, value, domain, path, secure, httpOnly, ...(sameSite ? { sameSite } : {}), ...(expires > 0 ? { expires } : {}) })) })
    if (passed) await task.finish({ keep: [] })
    else console.error(`Browser check stopped in workspace ${task.spaceId}; inspect and resume this workspace before closing it.`)
  }
}
