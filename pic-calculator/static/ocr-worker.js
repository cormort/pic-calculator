/* PP-OCRv6 背景辨識 Worker。
 *
 * 為什麼用 jsDelivr 的 +esm：ppu-paddle-ocr 的 web 版以 bare specifier 匯入
 * onnxruntime-web，Worker 沒有頁面的 import map，+esm 會先把依賴改寫成
 * CDN 絕對路徑。ArrayBuffer 直接餵給 recognize()，不需要 OffscreenCanvas。
 */
import {
  PaddleOcrService,
  V6_SMALL_MODEL,
  V6_MEDIUM_MODEL,
} from 'https://cdn.jsdelivr.net/npm/ppu-paddle-ocr@6.7.0/web/+esm';

const QUALITY = {
  tiny: { label: '快速', size: '6MB', model: null },
  small: { label: '標準', size: '30MB', model: V6_SMALL_MODEL },
  medium: { label: '高精度', size: '139MB', model: V6_MEDIUM_MODEL },
};
const MIN_CONFIDENCE = 0.5;

let service = null, serviceQuality = null, toTraditional = null;

const postStatus = (text) => self.postMessage({ type: 'status', text });

async function ensureConverter() {
  if (!toTraditional) {
    const opencc = await import('https://cdn.jsdelivr.net/npm/opencc-js@1.4.2/dist/esm/cn2t.js');
    toTraditional = opencc.Converter({ from: 'cn', to: 'tw' });
  }
}

function cleanText(t) {
  return toTraditional(t.trim())
    .replace(/(?:線|綫|综|総)計$/, '總計')   // 模型常把「總計」讀成「線計」
    .replace(/(?<=[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef(（])\s+|\s+(?=[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef)）])/g, '');
}

async function ensureService(quality) {
  const q = QUALITY[quality] ? quality : 'small';
  if (service && serviceQuality === q) return service;
  if (service) {
    try { await service.destroy?.(); } catch (err) { /* 忽略 */ }
    service = null;
    serviceQuality = null;
  }
  const info = QUALITY[q];
  postStatus(`載入${info.label}模型（首次約 ${info.size}）…`);
  const svc = info.model
    ? new PaddleOcrService({ model: info.model })
    : new PaddleOcrService();
  await Promise.all([svc.initialize(), ensureConverter()]);
  service = svc;
  serviceQuality = q;
  return service;
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type !== 'ocr') return;
  const { id, quality, buffer } = msg;
  try {
    const svc = await ensureService(quality);
    postStatus('辨識中，請稍候…');
    // per-box：逐框辨識。預設逐行合併遇到歪斜 2° 以上的照片會整張讀成亂碼
    const res = await svc.recognize(buffer, {
      flatten: true,
      minimumConfidence: 0,
      strategy: 'per-box',
    });
    const confidence = res.results.length
      ? res.results.reduce((a, r) => a + r.confidence, 0) / res.results.length
      : 1;
    const results = res.results
      .filter((r) => r.confidence >= MIN_CONFIDENCE && r.text.trim())
      .map((r) => {
        const { x, y, width: w, height: h } = r.box;
        return {
          text: cleanText(r.text),
          x1: x, x2: x + w, y1: y, y2: y + h,
          cx: x + w / 2, cy: y + h / 2, h,
          score: r.confidence,
        };
      });
    self.postMessage({ type: 'result', id, confidence, results });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err?.message || err) });
  }
};
