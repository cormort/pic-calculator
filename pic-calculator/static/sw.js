const CACHE_NAME = 'pic-calc-v65';   // 與 index.html 的 APP_VERSION 一起換，舊 worker 才會被淘汰
// 離線需要的殼：安裝時先存好，第一次開啟之後就能離線使用
const SHELL = ['./', 'index.html', 'smart_total.js', 'ocr-worker.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];
// 函式庫與 OCR 模型（CDN，網址帶版本不會變）：快取優先
const CDN = /(^|\.)(jsdelivr\.net|huggingface\.co|hf\.co)$/;
// 模型與 CDN 函式庫另存一個快取，改版時不清（網址帶版本或檔名不變），手機不必每次改版重抓 30MB。
// 換模型檔時要改檔名，舊檔才不會一直被沿用
const MODEL_CACHE = 'pic-calc-models';

// 多執行緒 WASM（辨識約快一倍）需要 crossOriginIsolated，GitHub Pages 不能自訂標頭，
// 所以由 SW 幫自己網域的回應補上 COOP/COEP。CDN（jsDelivr、Hugging Face、gtag）
// 都有 CORS 或 CORP，require-corp 擋不到。第一次開啟時 SW 還沒接手，下次開才生效。
// 量測（2026-11-16，M 系列 Mac、6 張圖）：單執行緒每張約 4.2s → 4 執行緒約 2.2s，準確率不變
// ponytail: 只在 Chromium（Chrome、Edge、Android）開。Safari／iOS 上所有瀏覽器（都是 WebKit）
// 在 isolated 時，worker 一律拒絕 import CDN 模組（實測：伺服器直接送標頭、不經 SW 也一樣），
// 辨識直接壞掉；COEP credentialless 則讓 Chromium 卡住。所以 WebKit 維持單執行緒。
// 要讓 iPad 也多執行緒：把 jsDelivr 的模組改放到自己網域（同源就不受 COEP 影響）。
const ISOLATE = /Chrome\/\d/.test(self.navigator.userAgent);
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
  const url = new URL(req.url);
  const cdn = CDN.test(url.hostname);
  if (!cdn && url.origin !== location.origin) return;

  const longLived = cdn || url.pathname.includes('/models/');
  event.respondWith(caches.open(longLived ? MODEL_CACHE : CACHE_NAME).then(async cache => {
    const save = resp => { if (resp.ok) cache.put(req, resp.clone()); return resp; };
    // 本機的表格結構模型（7.7MB）也是快取優先：否則每次用到都重新下載、重寫一次快取。
    if (longLived) return (await cache.match(req)) || fetch(req).then(save);
    // 頁面與殼：網路優先（更新立即生效），離線才用快取。
    // ignoreSearch：安裝時存的是 smart_total.js，頁面要的是 smart_total.js?v=NN；
    // 只有「開頁面」才退回 index.html —— 拿 HTML 回應 JS／模型的請求只會讓錯誤更難懂
    return fetch(req).then(save).catch(async () => (await cache.match(req, { ignoreSearch: true }))
      || (req.mode === 'navigate' ? cache.match('index.html') : Response.error()));
  }).then(resp => cdn ? resp : isolate(resp)));
});
