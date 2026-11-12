/* PP-OCRv6 背景處理 Worker：表格偵測 + 透視矯正 + OCR。
 *
 * 為什麼用 jsDelivr 的 +esm：ppu-paddle-ocr 的 web 版以 bare specifier 匯入
 * onnxruntime-web，Worker 沒有頁面的 import map，+esm 會先把依賴改寫成
 * CDN 絕對路徑。辨識直接吃 OffscreenCanvas，不再需要 PNG 來回。
 */
import {
  PaddleOcrService,
  V6_SMALL_MODEL,
  V6_MEDIUM_MODEL,
  getDefaultWebExecutionProviders,
} from 'https://cdn.jsdelivr.net/npm/ppu-paddle-ocr@6.7.0/web/+esm';
// 與 ppu 內部使用同一個 onnxruntime-web 模組（同版本、同 URL），避免載入兩份 runtime
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/+esm';

const QUALITY = {
  tiny: { label: '快速', size: '6MB', model: null },
  small: { label: '標準', size: '30MB', model: V6_SMALL_MODEL },
  medium: { label: '高精度', size: '139MB', model: V6_MEDIUM_MODEL },
};
const MIN_CONFIDENCE = 0.5;
const FULL_QUAD = [[0, 0], [1, 0], [1, 1], [0, 1]];

const LAYOUT_MODEL = 'https://huggingface.co/stefanj0/PP-DocLayout-S-ONNX/resolve/7e851b9e5ad66613d7318a3213ab3336ebe0a514/pp_doclayout_s.onnx';
const TABLE_CLASS = 8, FALLBACK_CLASSES = [1, 18], TABLE_MIN_SCORE = 0.5;

let service = null, serviceQuality = null, serviceBackend = null, toTraditional = null;
let layoutSession = null, layoutEps = null;

const postStatus = (text) => self.postMessage({ type: 'status', text });

async function decodeImage(buffer) {
  const blob = new Blob([buffer]);
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (err) {
    return await createImageBitmap(blob);   // 舊瀏覽器沒有 imageOrientation 選項
  }
}

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
    serviceBackend = null;
  }
  const info = QUALITY[q];
  postStatus(`載入${info.label}模型（首次約 ${info.size}）…`);
  const svc = info.model
    ? new PaddleOcrService({ model: info.model })
    : new PaddleOcrService();
  await Promise.all([svc.initialize(), ensureConverter()]);
  const providers = svc.options?.session?.executionProviders || [];
  serviceBackend = providers.includes('webgpu') ? 'webgpu' : 'wasm';
  service = svc;
  serviceQuality = q;
  return service;
}

/* =============================================================
   表格偵測（PP-DocLayout-S）
   ============================================================= */
function layoutBackend() {
  if (!layoutEps) return null;
  return layoutEps.includes('webgpu') ? 'webgpu' : 'wasm';
}

async function createLayoutSession(eps) {
  return ort.InferenceSession.create(LAYOUT_MODEL, {
    executionProviders: eps,
    logSeverityLevel: 3,
  });
}

async function getLayoutSession() {
  if (layoutSession) return layoutSession;
  const eps = await getDefaultWebExecutionProviders();   // WebGPU 可用時為 ['webgpu','wasm']
  try {
    layoutSession = await createLayoutSession(eps);
    layoutEps = eps;
  } catch (err) {
    postStatus('WebGPU 不支援版面模型，改用 WASM…');
    layoutSession = await createLayoutSession(['wasm']);
    layoutEps = ['wasm'];
  }
  return layoutSession;
}

async function runLayout(makeInputs) {
  const session = await getLayoutSession();
  try {
    return await session.run(makeInputs());
  } catch (err) {
    if (!layoutEps || !layoutEps.includes('webgpu')) throw err;
    // layout 模型在部分 WebGPU 後端會因 MatMul 不支援而失敗，退回 WASM 重跑一次
    postStatus('WebGPU 執行版面模型失敗，改用 WASM…');
    try { await layoutSession.release?.(); } catch (releaseErr) { /* 忽略 */ }
    layoutSession = await createLayoutSession(['wasm']);
    layoutEps = ['wasm'];
    return await layoutSession.run(makeInputs());
  }
}

async function detectTable(bitmap) {
  const N = 480, W = bitmap.width, H = bitmap.height;
  const canvas = new OffscreenCanvas(N, N);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, N, N);
  const px = ctx.getImageData(0, 0, N, N).data;
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const data = new Float32Array(3 * N * N);
  for (let i = 0; i < N * N; i++) {
    for (let ch = 0; ch < 3; ch++) {
      data[ch * N * N + i] = (px[i * 4 + ch] / 255 - mean[ch]) / std[ch];
    }
  }
  const out = await runLayout(() => ({
    image: new ort.Tensor('float32', data, [1, 3, N, N]),
    scale_factor: new ort.Tensor('float32', [N / H, N / W], [1, 2]),
  }));
  const det = Object.values(out).find((t) => t.dims.length === 2 && t.dims[1] === 6);
  if (!det) return null;

  let best = null;
  for (let i = 0; i < det.dims[0]; i++) {
    const [cls, score, x1, y1, x2, y2] = det.data.subarray(i * 6, i * 6 + 6);
    // 表格類別放寬到 0.4：掃描/截圖的 table 分數常在 0.45–0.5 之間
    const minScore = cls === TABLE_CLASS ? 0.4 : TABLE_MIN_SCORE;
    if (score < minScore || !(cls === TABLE_CLASS || FALLBACK_CLASSES.includes(cls))) continue;
    const rank = score + (cls === TABLE_CLASS ? 1 : 0);
    if (!best || rank > best.rank) best = { rank, x1, y1, x2, y2 };
  }
  if (!best) return null;

  // 框離圖片邊緣不到 4% 時直接貼齊邊緣：表格常一路延伸到照片邊上，
  // 模型的框會略為內縮，切掉最外側的字（實拍：9,900 被切成 9,90）
  const pad = 0.01, f = (v) => { v = Math.min(1, Math.max(0, v)); return v < 0.04 ? 0 : v > 0.96 ? 1 : v; };
  const x1 = f(best.x1 / W - pad), y1 = f(best.y1 / H - pad);
  const x2 = f(best.x2 / W + pad), y2 = f(best.y2 / H + pad);
  return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
}

/* =============================================================
   透視矯正（移植自主執行緒版本）
   ============================================================= */
function orderPoints(pts) {
  const byX = [...pts].sort((a, b) => a[0] - b[0]);
  const [tl, bl] = byX.slice(0, 2).sort((a, b) => a[1] - b[1]);
  const [tr, br] = byX.slice(2).sort((a, b) => a[1] - b[1]);
  return [tl, tr, br, bl];
}

function homography(w, h, src) {
  const dst = [[0, 0], [w, 0], [w, h], [0, h]], A = [];
  dst.forEach(([u, v], k) => {
    const [x, y] = src[k];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x], [0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  });
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[8] / row[i]);
}

function rectifiedCanvas(bitmap, quad) {
  const q = Array.isArray(quad) && quad.length === 4 ? quad : FULL_QUAD;
  const s0 = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
  const W = Math.round(bitmap.width * s0), H = Math.round(bitmap.height * s0);
  const src = new OffscreenCanvas(W, H);
  const sg = src.getContext('2d', { willReadFrequently: true });
  sg.drawImage(bitmap, 0, 0, W, H);
  const rgba = sg.getImageData(0, 0, W, H).data;
  const gray = new Uint8Array(W * H);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114;
  }

  const pts = orderPoints(q.map(([x, y]) => [x * (W - 1), y * (H - 1)]));
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w0 = Math.max(dist(pts[0], pts[1]), dist(pts[3], pts[2]), 1);
  const h0 = Math.max(dist(pts[0], pts[3]), dist(pts[1], pts[2]), 1);
  const scale = Math.min(3, 2560 / Math.max(w0, h0));
  const dw = Math.round(w0 * scale), dh = Math.round(h0 * scale);
  const m = homography(dw - 1, dh - 1, pts);

  const out = new OffscreenCanvas(dw, dh);
  const og = out.getContext('2d');
  const id = og.createImageData(dw, dh), d = id.data;
  const outGray = new Uint8Array(dw * dh);   // 給格線偵測用
  for (let v = 0, o = 0; v < dh; v++) {
    for (let u = 0; u < dw; u++, o += 4) {
      const z = m[6] * u + m[7] * v + 1;
      const x = Math.min(W - 1.001, Math.max(0, (m[0] * u + m[1] * v + m[2]) / z));
      const y = Math.min(H - 1.001, Math.max(0, (m[3] * u + m[4] * v + m[5]) / z));
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, p = y0 * W + x0;
      const top = gray[p] + (gray[p + 1] - gray[p]) * fx;
      const bot = gray[p + W] + (gray[p + W + 1] - gray[p + W]) * fx;
      d[o] = d[o + 1] = d[o + 2] = outGray[o >> 2] = top + (bot - top) * fy;
      d[o + 3] = 255;
    }
  }
  og.putImageData(id, 0, 0);
  return { canvas: out, gray: outGray, width: dw, height: dh };
}

/* =============================================================
   格線偵測：找表格的直線與橫線，讓切欄切列不必靠空白去猜
   ============================================================= */
// 回傳每條線的 { a, b }：直線 x = a + b*y，橫線 y = a + b*x（容許照片歪一點）
// 做法：沿線的方向切成數段，每段統計「比兩側都暗的細線像素」落在哪個位置，
// 一段裡幾乎每一列都有 → 該處有線；再把各段的位置串起來，夠多段都有才算一條線。
// 文字筆畫只佔一段的一小部分，串不起來，所以不會被當成線。
function detectLines(gray, W, H, vertical) {
  const A = vertical ? W : H, L = vertical ? H : W;   // A：跨線方向，L：沿線方向
  const r = Math.max(4, Math.round(Math.max(W, H) / 200));   // 比線寬的一半大
  const S = Math.max(4, Math.min(12, Math.floor(L / 120)));
  const stripL = Math.floor(L / S);
  if (stripL < 20 || A < 6 * r) return [];
  const T = 20, tol = 2 * r + 0.06 * stripL;
  const tracks = [];
  for (let s = 0; s < S; s++) {
    const counts = new Uint16Array(A), stamp = new Int32Array(A);
    for (let l = s * stripL, end = l + stripL; l < end; l++) {
      for (let a = r; a < A - r; a++) {
        const i = vertical ? l * W + a : a * W + l, step = vertical ? r : r * W;
        const v = gray[i] + T;
        if (v < gray[i - step] && v < gray[i + step]) {
          for (let k = a - 2; k <= a + 2; k++) if (stamp[k] !== l + 1) { stamp[k] = l + 1; counts[k]++; }
        }
      }
    }
    const thr = stripL * 0.7, mid = (s + 0.5) * stripL;
    for (let a = 0; a < A; a++) {
      if (counts[a] < thr) continue;
      let e = a;
      while (e + 1 < A && counts[e + 1] >= thr) e++;
      const pos = (a + e) / 2;
      a = e;
      let best = null;
      for (const t of tracks) {
        if (t.lastS < s - 2 || t.lastS === s) continue;
        const d = Math.abs(t.last - pos);
        if (d <= tol && (!best || d < Math.abs(best.last - pos))) best = t;
      }
      if (!best) tracks.push(best = { pts: [] });
      best.pts.push([mid, pos]); best.last = pos; best.lastS = s;
    }
  }
  return tracks.filter(t => t.pts.length >= Math.ceil(S * 0.6)).map(t => {
    const n = t.pts.length;
    let sl = 0, sp = 0, sll = 0, slp = 0;
    for (const [l, p] of t.pts) { sl += l; sp += p; sll += l * l; slp += l * p; }
    const den = n * sll - sl * sl, b = den ? (n * slp - sl * sp) / den : 0;
    return { a: (sp - b * sl) / n, b };
  }).sort((p, q) => (p.a + p.b * L / 2) - (q.a + q.b * L / 2));
}

/* =============================================================
   訊息處理
   ============================================================= */
self.onmessage = async (event) => {
  const msg = event.data || {};
  const { id } = msg;
  try {
    if (msg.type === 'detect') {
      postStatus('偵測表格範圍…');
      const bitmap = await decodeImage(msg.buffer);
      let quad = null;
      try { quad = await detectTable(bitmap); } finally { bitmap.close(); }
      self.postMessage({ type: 'detect-result', id, quad, backend: { layout: layoutBackend() } });
      return;
    }
    if (msg.type !== 'ocr') return;

    const svc = await ensureService(msg.quality);
    postStatus('辨識中，請稍候…');
    const bitmap = await decodeImage(msg.buffer);
    let canvas, grid = null;
    try {
      const rect = rectifiedCanvas(bitmap, msg.quad);
      canvas = rect.canvas;
      try {
        grid = {
          v: detectLines(rect.gray, rect.width, rect.height, true),
          h: detectLines(rect.gray, rect.width, rect.height, false),
        };
      } catch (err) { /* 格線只是輔助，失敗就照舊用空白切欄 */ }
    } finally { bitmap.close(); }
    // per-box：逐框辨識。預設逐行合併遇到歪斜 2° 以上的照片會整張讀成亂碼
    const res = await svc.recognize(canvas, {
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
    self.postMessage({ type: 'result', id, confidence, results, grid, backend: { ocr: serviceBackend, layout: layoutBackend() } });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err?.message || err) });
  }
};
