import type { PublicNodeKind } from './public-node.js'

/**
 * The pages the gateway serves itself before the Host app is reachable. They
 * borrow the Host's own design tokens (DSH 0.2.2): the same surface, ink,
 * muted ink, hairline, radii and type scale a phone meets one step later, so a
 * pairing prompt never looks like a different product. Only the primary action
 * uses the one accent colour this plugin ships with.
 */
const tokens = (dark: boolean): string => dark
  ? '--rc-bg:#151517;--rc-ink:#F9FAFB;--rc-muted:#ADB2B8;--rc-faint:#ADB2B8;--rc-line:rgba(255,255,255,.16);--rc-fill:#353638'
  : '--rc-bg:#FFFFFF;--rc-ink:#0F1115;--rc-muted:#61666B;--rc-faint:#818588;--rc-line:rgba(0,0,0,.12);--rc-fill:#F5F6F7'
const css = `:root{color-scheme:light dark;--rc-accent:#D97757;--rc-accent-hover:#C86748;--rc-accent-ink:#FFFFFF;${tokens(false)};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif;background:var(--rc-bg);color:var(--rc-ink);-webkit-text-size-adjust:100%}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;padding-bottom:max(24px,env(safe-area-inset-bottom));padding-left:max(24px,env(safe-area-inset-left));padding-right:max(24px,env(safe-area-inset-right))}.card{background:var(--rc-bg);border:1px solid var(--rc-line);border-radius:12px;padding:24px;max-width:440px;width:100%}.eyebrow{color:var(--rc-faint);font-size:13px}h1{font-size:26px;font-weight:500;line-height:1.25;margin:12px 0 8px}p{font-size:14px;line-height:1.7;color:var(--rc-muted);margin:0 0 16px}a{color:var(--rc-accent);font-size:14px}button{background:var(--rc-accent);border:0;color:var(--rc-accent-ink);border-radius:12px;padding:0 20px;min-height:44px;font:inherit;font-size:15px;font-weight:500;width:100%;cursor:pointer}button:hover{background:var(--rc-accent-hover)}button:disabled{background:var(--rc-fill);color:var(--rc-faint);cursor:default}label{display:block;font-size:13px;color:var(--rc-muted);margin-bottom:8px}input{width:100%;height:48px;margin:0 0 16px;border:1px solid var(--rc-line);border-radius:8px;background:var(--rc-fill);color:var(--rc-ink);text-align:center;font:500 24px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.24em}input:focus-visible,button:focus-visible{outline:2px solid var(--rc-accent);outline-offset:2px}.status{display:flex;align-items:center;gap:8px;margin:20px 0 0;color:var(--rc-ink);font-size:14px;line-height:1.6}.dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--rc-accent)}small{display:block;margin-top:12px;color:var(--rc-faint);font-size:13px;line-height:1.7;word-break:break-word}code{font-size:12px;word-break:break-all}[hidden]{display:none!important}@media(prefers-color-scheme:dark){:root{${tokens(true)}}}`
/** The phone paints its own chrome from these, so it matches the page on both themes. */
const themeColor = '<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme:light)"><meta name="theme-color" content="#151517" media="(prefers-color-scheme:dark)">'
const head = (title: string) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">${themeColor}<meta name="referrer" content="no-referrer"><title>${title}</title><style>${css}</style></head>`
const healthCheck = `const health=await fetch('/api/dsh-remote-connect/manage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'requests'})}).catch(()=>null);
    if(health&&health.ok){location.replace('/');return true}return false`

/** What a public pairing page shows before anything is sent: the node the browser is talking to. */
export interface PairingNode { name: string; kind: PublicNodeKind; fingerprint: string; fingerprintGroups: string; protocol: number }

const nodeRow = (label: string, value: string, mono = false): string => `<dt style="color:var(--rc-faint);font-size:12px;margin:0 0 2px">${label}</dt><dd style="margin:0 0 12px;color:var(--rc-ink);font-size:14px;line-height:1.6;word-break:break-word${mono ? ';font-family:ui-monospace,SFMono-Regular,Menlo,monospace' : ''}">${value}</dd>`

export function pairingPage(node?: PairingNode): string {
  const progress = `<div id="progress" ${node ? 'hidden' : ''}><div class="status"><span class="dot"></span><span id="state">正在发送配对请求…</span></div><small>授权后，这台设备与本机拥有相同的操作权限。你可以随时在远程控制面板撤销设备。</small><button id="enter" hidden>进入 DeepSeek Harness</button></div>`
  if (node) {
    const identity = `<p>先核对这台电脑的身份，确认是本机后再继续。随后还需要在电脑上的远程控制面板再确认一次，两次确认都完成才会授权。</p><dl style="margin:0 0 16px;padding:14px 16px;border:1px solid var(--rc-line);border-radius:10px;background:var(--rc-fill)">${nodeRow('节点名称', escapeHTML(node.name))}${nodeRow('类型', node.kind === 'gateway' ? '隧道网关' : '自托管服务')}${nodeRow('主机指纹', escapeHTML(node.fingerprintGroups), true)}${nodeRow('协议版本', `v${node.protocol}`)}</dl><p id="error" role="alert"></p><button id="confirm">确认是本机</button>`
    return head('连接 DeepSeek Harness') + `<body><main class="card"><span class="eyebrow">DSH · 远程</span><h1>连接你的电脑</h1>${identity}${progress}</main><script>
  (async()=>{const state=document.getElementById('state'),enter=document.getElementById('enter'),confirm=document.getElementById('confirm'),progress=document.getElementById('progress'),error=document.getElementById('error');
  const nodeFingerprint=${JSON.stringify(node.fingerprint)};
  const token=new URLSearchParams(location.hash.slice(1)).get('pair');history.replaceState(null,'','/pair');let claim;
  const connect=async()=>{enter.hidden=true;state.textContent='正在检查连接…';error.textContent='';try{
    if(await (async()=>{${healthCheck}})()){state.textContent='这台设备已经配对过，正在打开…'}
    else{
    if(!claim){if(!token)throw Error('请在电脑上开启远程控制并扫描新的二维码。');
    let model='';try{const hints=await navigator.userAgentData?.getHighEntropyValues(['model']);model=hints?.model||''}catch{}
    const request=await fetch('/rc/pair/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,model,fingerprint:nodeFingerprint})});const result=await request.json();if(!request.ok)throw Error(result.error||'配对请求失败');claim=result}
    state.textContent='等待电脑确认，请查看本机远程控制面板';
    while(Date.now()<claim.expiresAt){await new Promise(r=>setTimeout(r,1500));const response=await fetch('/rc/pair/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:claim.id,key:claim.key})});const result=await response.json();if(!response.ok)throw Error(result.error||'请求已失效');if(result.state==='rejected')throw Error('电脑已拒绝本次配对。');if(result.state==='approved'){state.textContent='已连接，正在打开远程界面…';location.replace('/');return}}
    throw Error('配对请求已过期，请重新扫码。')}
  }catch(failure){error.textContent=failure.message;state.textContent='确认失败，请重试。';enter.hidden=false;enter.textContent='重新检查连接';confirm.hidden=true}};
  confirm.onclick=()=>{confirm.disabled=true;progress.hidden=false;void connect()};
  enter.onclick=connect})();
  </script></body></html>`
  }
  return head('连接 DeepSeek Harness') + `<body><main class="card"><span class="eyebrow">DSH · 远程</span><h1>连接你的电脑</h1><p>在电脑上确认这次配对后，你就可以在这里继续使用 DeepSeek Harness。</p>${progress}</main><script>
  (async()=>{const state=document.getElementById('state'),enter=document.getElementById('enter');
  const token=new URLSearchParams(location.hash.slice(1)).get('pair');history.replaceState(null,'','/pair');let claim;
  const connect=async()=>{enter.hidden=true;state.textContent='正在检查连接…';try{
    if(await (async()=>{${healthCheck}})()){state.textContent='这台设备已经配对过，正在打开…'}
    else{
    if(!claim){if(!token)throw Error('请在电脑上开启远程控制并扫描新的二维码。');
    let model='';try{const hints=await navigator.userAgentData?.getHighEntropyValues(['model']);model=hints?.model||''}catch{}
    const request=await fetch('/rc/pair/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,model})});const result=await request.json();if(!request.ok)throw Error(result.error||'配对请求失败');claim=result}
    state.textContent='等待电脑确认，请查看本机远程控制面板';
    while(Date.now()<claim.expiresAt){await new Promise(r=>setTimeout(r,1500));const response=await fetch('/rc/pair/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:claim.id,key:claim.key})});const result=await response.json();if(!response.ok)throw Error(result.error||'请求已失效');if(result.state==='rejected')throw Error('电脑已拒绝本次配对。');if(result.state==='approved'){state.textContent='已连接，正在打开远程界面…';location.replace('/');return}}
    throw Error('配对请求已过期，请重新扫码。')}
  }catch(error){state.textContent=error.message;enter.hidden=false;enter.textContent='重新检查连接'}};
  enter.onclick=connect;await connect()})();
  </script></body></html>`
}

export function deniedPage(reason?: string): string {
  const message = reason ? `${escapeHTML(reason)}` : '这台设备尚未配对，授权已过期，或已被撤销。请在电脑上打开远程控制面板，扫描新的二维码并确认配对。'
  const next = reason ? '<p>请在电脑上打开远程控制面板，扫描同一台电脑的新二维码并确认配对。</p>' : ''
  return head('设备尚未授权') + `<body><main class="card"><span class="eyebrow">DSH · 远程</span><h1>需要重新连接</h1><p>${message}</p>${next}<small>固定公网域名不会随重启改变。已授权设备可以继续使用原地址；新设备需要扫码并在电脑上确认配对。</small></main></body></html>`
}

const escapeHTML = (value: string): string => value.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!)

/** The gateway is up but the Host behind it did not hand over its page: the phone needs a reason and a way back. */
export function unavailablePage(detail?: string): string {
  return head('电脑暂时没有响应') + `<body><main class="card"><span class="eyebrow">DSH · 远程</span><h1>电脑暂时没有响应</h1><p>远程连接是通的，但电脑上的 DeepSeek Harness 没有返回界面。请确认电脑仍在运行、会话没有退出，然后重试。</p>${detail ? `<small>原因：<code>${escapeHTML(detail)}</code></small>` : ''}<button onclick="location.reload()">重试</button></main></body></html>`
}
