export const PREVIEW_WORKER_PATH = '/rc/preview-worker.js'

export function previewWorkerScript(): string {
  return String.raw`
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin ||
    !/^\/rc\/workspace-preview\/[A-Za-z0-9_-]{43}\//.test(url.pathname)) return;
  event.respondWith((async () => {
    const owner = event.clientId && await self.clients.get(event.clientId);
    const pages = await self.clients.matchAll({type: 'window'});
    for (const page of new Set([owner, ...pages.filter(page => page.visibilityState === 'visible'), ...pages])) {
      if (!page) continue;
      const path = new URL(page.url).pathname;
      if (path !== '/' && path !== '/index.html') continue;
      const moved = await new Promise(resolve => {
        const pipe = new MessageChannel();
        const end = value => { clearTimeout(timeout); pipe.port1.close(); resolve(value); };
        const timeout = setTimeout(() => end(null), 2000);
        pipe.port1.onmessage = ({data}) => end(data);
        try { page.postMessage({ type: 'dsh-preview', url: url.href }, [pipe.port2]); }
        catch { end(null); }
      });
      if (moved) return new Response(moved.body, {status: moved.status, headers: moved.headers});
    }
    return fetch(request);
  })());
});`
}
