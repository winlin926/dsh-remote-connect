import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { createBootScreen } from '../src/boot-screen.ts'

const require = createRequire(import.meta.url)
const dshRequire = createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
const whale = readFileSync(dshRequire.resolve('@deepseek-ai/dsh-web-frontend/dist/favicon.svg'))
const html = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>DSH Carry · 启动页预览</title>
<style>
.preview{position:fixed;z-index:2147483646;bottom:max(16px,env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:8px;white-space:nowrap;background:Canvas;color:CanvasText;font:13px system-ui}
.preview:has(~ [data-theme=light]){color-scheme:light}
.preview:has(~ [data-theme=dark]){color-scheme:dark}
.preview select{min-height:44px;padding:0 8px;border:1px solid GrayText;border-radius:6px;background:Canvas;color:CanvasText;font:inherit}
</style>
<body>
<label class="preview">预览阶段 <select>
<option>检查插件</option><option>检查结论</option><option selected>加载模块</option><option>初始化插件</option><option>启动完成</option>
</select></label>
<script>
const screen = (${createBootScreen.toString()})();
const frames = [
  { stage: '正在检查插件变化…', detail: '正在读取插件清单…', progress: 'pending' },
  { stage: '插件清单未变化', count: '共 12 个模块', progress: 'pending' },
  { stage: '正在加载模块', count: '3 / 12 个模块', detail: '正在准备：界面主题', progress: 3 / 12 },
  { stage: '正在初始化插件', count: '12 / 12 个模块', detail: '正在接管工作区…', progress: 1 },
  { stage: '✓ 启动完成', detail: '工作区已就绪', progress: null, complete: true },
];
const picker = document.querySelector('select');
function render() {
  const frame = frames[picker.selectedIndex];
  screen.paint({ ...frame, announcement: frame.stage });
}
picker.onchange = render;
render();
</script>
</body></html>`

const server = createServer((req, res) => {
  if (req.url === '/favicon.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end(whale) }
  else if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html) }
  else { res.writeHead(404); res.end() }
})
server.listen(Number(process.env.PORT) || 0, '127.0.0.1', () => console.log(`DSH 启动页预览：http://127.0.0.1:${server.address().port}/`))
