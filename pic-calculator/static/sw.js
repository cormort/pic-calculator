const CACHE_NAME = 'pic-calc-v38';   // 與 index.html 的 APP_VERSION 一起換，舊 worker 才會被淘汰
// 離線需要的殼：安裝時先存好，第一次開啟之後就能離線使用
const SHELL = ['./', 'index.html', 'smart_total.js', 'ocr-worker.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];
// 函式庫與 OCR 模型（CDN，網址帶版本不會變）：快取優先
const CDN = /(^|\.)(jsdelivr\.net|huggingface\.co|hf\.co)$/;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      // 只刪自己的舊版：cormort.github.io 上的其他專案共用同一網域的快取空間
      .then(keys => Promise.all(keys.filter(k => k.startsWith('pic-calc-') && k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const cdn = CDN.test(url.hostname);
  if (!cdn && url.origin !== location.origin) return;

  event.respondWith(caches.open(CACHE_NAME).then(async cache => {
    const save = resp => { if (resp.ok) cache.put(req, resp.clone()); return resp; };
    if (cdn) return (await cache.match(req)) || fetch(req).then(save);
    // 頁面與殼：網路優先（更新立即生效），離線才用快取
    return fetch(req).then(save).catch(async () => (await cache.match(req)) || cache.match('index.html'));
  }));
});
