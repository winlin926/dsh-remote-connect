export interface BootFrame {
  stage: string
  count?: string
  detail?: string
  progress: number | 'pending' | null
  complete?: boolean
  announcement: string
}

export function createBootScreen() {
  const make = (tag: string, className: string, parent?: HTMLElement) => {
    const element = document.createElement(tag)
    element.className = className
    parent?.append(element)
    return element
  }
  const write = (element: HTMLElement, text: string) => { if (element.textContent !== text) element.textContent = text }
  const style = document.createElement('style')
  style.id = 'dsh-rc-boot-style'
  style.textContent = `#dsh-rc-boot-screen{position:fixed;inset:0;z-index:2147483645;display:grid;place-items:center;box-sizing:border-box;padding:64px max(20px,env(safe-area-inset-right)) 64px max(20px,env(safe-area-inset-left));background:Canvas;color:CanvasText;color-scheme:light dark;font:14px/1.5 system-ui,sans-serif;pointer-events:none;transition:opacity 160ms ease-out}
#dsh-rc-boot-screen[data-theme=light]{color-scheme:light}
#dsh-rc-boot-screen[data-theme=dark]{color-scheme:dark}
#dsh-rc-boot-screen .theme{position:absolute;top:max(16px,env(safe-area-inset-top));right:max(16px,env(safe-area-inset-right));display:flex;align-items:center;padding:4px;gap:2px;border:1px solid color-mix(in srgb,CanvasText 12%,Canvas);border-radius:999px;background:color-mix(in srgb,CanvasText 5%,Canvas);box-shadow:0 3px 14px color-mix(in srgb,CanvasText 8%,transparent);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);pointer-events:auto}
#dsh-rc-boot-screen .theme button{appearance:none;display:flex;align-items:center;justify-content:center;gap:5px;border:1px solid transparent;border-radius:999px;min-width:44px;min-height:40px;padding:0 10px;background:transparent;color:GrayText;font:inherit;font-size:12px;font-weight:550;white-space:nowrap;cursor:pointer}
#dsh-rc-boot-screen .theme button svg{width:14px;height:14px;flex:none}
#dsh-rc-boot-screen .theme button:hover:not([aria-pressed=true]){background:color-mix(in srgb,CanvasText 6%,Canvas);color:CanvasText}
#dsh-rc-boot-screen .theme button[aria-pressed=true]{border-color:color-mix(in srgb,CanvasText 9%,Canvas);background:Canvas;color:CanvasText;box-shadow:0 1px 4px color-mix(in srgb,CanvasText 10%,transparent)}
#dsh-rc-boot-screen .theme button:focus-visible{outline:2px solid CanvasText;outline-offset:2px}
#dsh-rc-boot-screen .content{display:grid;justify-items:center;grid-template-rows:auto auto minmax(30px,auto) minmax(22px,auto) minmax(22px,auto) 6px;row-gap:3px;width:min(100%,320px);min-width:0;text-align:center;overflow-wrap:anywhere}
#dsh-rc-boot-screen .whale{width:88px;height:88px;background:CanvasText;-webkit-mask:url('/favicon.svg') center/contain no-repeat;mask:url('/favicon.svg') center/contain no-repeat}
#dsh-rc-boot-screen .brand{margin:0 0 23px;color:GrayText;font-size:12px;font-weight:600}
#dsh-rc-boot-screen .stage{font-size:21px;font-weight:600}
#dsh-rc-boot-screen .count{font-size:14px;font-variant-numeric:tabular-nums}
#dsh-rc-boot-screen .detail{color:GrayText;font-size:13px}
#dsh-rc-boot-screen .track{position:relative;width:min(88%,280px);height:4px;align-self:end;transform:translateY(14px);overflow:hidden;border-radius:4px;background:color-mix(in srgb,CanvasText 15%,Canvas)}
#dsh-rc-boot-screen .fill{height:100%;max-width:100%;overflow:hidden;background:CanvasText;transition:width 180ms ease-out}
#dsh-rc-boot-screen .sweep{display:block;width:36%;height:100%;background:linear-gradient(90deg,transparent,color-mix(in srgb,Canvas 72%,transparent),transparent);animation:dsh-rc-sweep 1.6s ease-in-out infinite}
#dsh-rc-boot-screen .track[data-pending=true] .fill{display:none}
#dsh-rc-boot-screen .track[data-pending=true]::after{content:'';position:absolute;inset:0 auto 0 0;width:36%;background:linear-gradient(90deg,transparent,GrayText,transparent);animation:dsh-rc-sweep 1.6s ease-in-out infinite}
#dsh-rc-boot-screen[data-ready=true] .content{grid-template-rows:auto auto;gap:6px}
#dsh-rc-boot-screen[data-ready=true] :is(.brand,.whale,.count,.track){display:none}
#dsh-rc-boot-screen[data-fade=true]{opacity:0}
#dsh-rc-boot-live{position:fixed;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@keyframes dsh-rc-sweep{from{transform:translateX(-100%)}to{transform:translateX(285%)}}
@media(max-height:440px){#dsh-rc-boot-screen .whale{width:56px;height:56px}#dsh-rc-boot-screen .brand{margin-bottom:8px}}
@media(prefers-reduced-motion:reduce){#dsh-rc-boot-screen,#dsh-rc-boot-screen .fill{transition:none}#dsh-rc-boot-screen .sweep{display:none}#dsh-rc-boot-screen .track[data-pending=true]::after{animation:none;transform:translateX(89%)}}`
  const root = make('div', '')
  root.id = 'dsh-rc-boot-screen'
  root.setAttribute('lang', 'zh-CN')
  const theme = make('div', 'theme', root)
  theme.setAttribute('role', 'group')
  theme.setAttribute('aria-label', '启动页配色')
  const themeKey = 'dsh-rc-boot-theme'
  let selected = 'system'
  try { selected = window.localStorage?.getItem(themeKey) ?? 'system' } catch { /* storage is optional */ }
  if (selected !== 'light' && selected !== 'dark') selected = 'system'
  const buttons = (['system', 'light', 'dark'] as const).map((value, index) => {
    const button = make('button', '', theme) as HTMLButtonElement
    button.type = 'button'
    const label = ['跟随系统', '亮色', '暗色'][index]!
    const icon = [
      '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
      '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>',
      '<path d="M20.5 15.5A8.5 8.5 0 0 1 8.5 3.5 8.5 8.5 0 1 0 20.5 15.5Z"/>',
    ][index]!
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg><span>${label}</span>`
    button.setAttribute('aria-label', label)
    button.title = label
    button.onclick = () => {
      selectTheme(value)
      try { window.localStorage?.setItem(themeKey, value) } catch { /* storage is optional */ }
    }
    return { value, button }
  })
  function selectTheme(value: string) {
    root.dataset.theme = value
    for (const entry of buttons) entry.button.setAttribute('aria-pressed', String(entry.value === value))
  }
  selectTheme(selected)
  const content = make('div', 'content', root)
  make('div', 'whale', content).setAttribute('aria-hidden', 'true')
  make('div', 'brand', content).textContent = 'DeepSeek Harness'
  const stage = make('div', 'stage', content), count = make('div', 'count', content), detail = make('div', 'detail', content)
  const track = make('div', 'track', content)
  track.setAttribute('aria-hidden', 'true')
  const fill = make('div', 'fill', track)
  make('span', 'sweep', fill)
  const live = make('div', '')
  live.id = 'dsh-rc-boot-live'
  live.setAttribute('lang', 'zh-CN')
  live.setAttribute('role', 'status')
  live.setAttribute('aria-live', 'polite')
  live.setAttribute('aria-atomic', 'true')
  const mount = () => {
    const host = document.body ?? document.documentElement
    if (root.parentElement !== host) host.append(live, root)
  }
  document.head.append(style)
  mount()
  return {
    mount,
    paint(frame: BootFrame) {
      mount()
      write(stage, frame.stage); write(count, frame.count ?? ''); write(detail, frame.detail ?? '')
      root.dataset.ready = String(!!frame.complete)
      theme.style.display = frame.complete ? 'none' : ''
      track.style.display = frame.progress === null ? 'none' : ''
      track.dataset.pending = String(frame.progress === 'pending')
      fill.style.width = typeof frame.progress === 'number' ? frame.progress * 100 + '%' : ''
      write(live, frame.announcement)
    },
    hideControls() { theme.remove() },
    fade() { root.dataset.fade = 'true' },
    remove() { root.remove(); live.remove(); style.remove() },
  }
}
