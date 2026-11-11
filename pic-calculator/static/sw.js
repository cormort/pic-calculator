const CACHE_NAME = 'pic-calc-v2';
// 函式庫與 OCR 模型（網址帶版本，不會變）：快取優先，下載一次即可離線使用
const CDN_HOSTS = ['cdn.jsdelivr.net', 'huggingface.co'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isCdn = CDN_HOSTS.includes(url.hostname);
  if (!isCdn && url.origin !== location.origin) return;

  event.respondWith(caches.open(CACHE_NAME).then(async cache => {
    const save = resp => { if (resp.ok) cache.put(req, resp.clone()); return resp; };
    if (isCdn) return (await cache.match(req)) || fetch(req).then(save);
    // 頁面本身：網路優先（更新立即生效），離線才用快取
    return fetch(req).then(save).catch(() => cache.match(req));
  }));
});
