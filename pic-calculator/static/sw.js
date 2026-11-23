const CACHE_NAME = 'pic-calc-v79';   // 與 index.html 的 APP_VERSION 一起換，舊 worker 才會被淘汰
// 離線需要的殼：安裝時先存好，第一次開啟之後就能離線使用
const SHELL = [
  './', 'index.html', 'styles.css', 'smart_total.js', 'validator.js',
  'table_builder.js', 'text_amounts.js', 'template.js', 'ocr-worker.js',
  'manifest.json', 'icon-192.png', 'icon-512.png',
];
// 函式庫與 OCR 模型（CDN，網址帶版本不會變）：快取優先
const CDN = /(^|\.)(jsdelivr\.net|huggingface\.co|hf\.co)$/;
// 模型與 CDN 函式庫另存一個快取，改版時不清（網址帶版本或檔名不變），手機不必每次改版重抓 30MB。
// 換模型檔時要改檔名，舊檔才不會一直被沿用
const MODEL_CACHE = 'pic-calc-models';

// 多執行緒 WASM（辨識約快一倍）需要 crossOriginIsolated，GitHub Pages 不能自訂標頭，
// 所以由 SW 幫自己網域的回應補上 COOP/COEP。CDN（jsDelivr、Hugging Face、gtag）
// 都有 CORS 或 CORP，require-corp 擋不到。第一次開啟時 SW 還沒接手，下次開才生效。
// 僅在 Chromium 與桌機 Firefox 啟用；iOS/iPadOS 所有瀏覽器底層都是 WebKit，
// 在 isolated 時 worker 會拒絕 import CDN 模組，維持單執行緒以確保可正常辨識。
const ua = self.navigator.userAgent;
const ISOLATE = (/Chrome\/\d/.test(ua) || /Firefox\/\d/.test(ua)) && !/iPhone|iPad|iPod|CriOS|FxiOS/.test(ua);
function isolate(resp) {
  if (!ISOLATE || !resp || resp.type === 'opaque' || resp.status === 0) return resp;
  const headers = new Headers(resp.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

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
      .then(keys => Promise.all(keys.filter(k => k.startsWith('pic-calc-') && k !== CACHE_NAME && k !== MODEL_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.headers.get('X-Predownload') === '1') return;
  const url = new URL(req.url);
  const cdn = CDN.test(url.hostname);
  if (!cdn && url.origin !== location.origin) return;

  const longLived = cdn || url.pathname.includes('/models/');
  event.respondWith(caches.open(longLived ? MODEL_CACHE : CACHE_NAME).then(async cache => {
    const save = resp => {
      if (resp.ok) event.waitUntil(cache.put(req, resp.clone()).catch(() => {}));
      return resp;
    };
    // 本機的表格結構模型與 CDN 套件快取優先；不包進 isolate 避免重建數十 MB 串流
    if (longLived) return (await cache.match(req)) || fetch(req).then(save);
    // 頁面與殼：網路優先（更新立即生效），離線才用快取。
    // ignoreSearch：安裝時存的是 smart_total.js，頁面要的是 smart_total.js?v=NN；
    // 只有「開頁面」才退回 index.html —— 拿 HTML 回應 JS／模型的請求只會讓錯誤更難懂
    return fetch(req).then(save).catch(async () => (await cache.match(req, { ignoreSearch: true }))
      || (req.mode === 'navigate' ? cache.match('index.html') : Response.error()));
  }).then(resp => (cdn || longLived ? resp : isolate(resp))));
});
