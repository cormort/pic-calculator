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
   送 OCR 前的照明正規化
   ============================================================= */
// 實拍最大的殺手不是模糊，而是不均勻照明：半邊陰影、手機閃光、檯燈造成
// 一邊 240 一邊 120，模型看到的是兩種字。做法是每個像素除以「附近平均亮度」
// （除以低頻背景），把亮度差壓平、筆畫保留下來；背景在 1/8 解析度上估，
// 成本可忽略。只在送 OCR 的那一份做，找格線用原本的 gray。
// 只在「照明真的不均勻」的照片上做 —— 量測結果：對半邊陰影的實拍 +10 格，
// 但對乾淨截圖會掉 1~3 格（多一次重取樣＝多一次失真）。所以先用低頻背景的
// 亮度分佈判斷這張需不需要，而不是一律套用。
// 量測結論（6 張測試圖、304 格）：一律套用 → 92.1%，但乾淨截圖各掉 1~3 格；
// 改成「只看光線離散程度才套」→ 89.8%（比不套的 90.5% 還差），且 b-photo 沒救回。
// 所以先關掉：留著程式與量測紀錄，等有真實手機照（反光、閃光、紙紋）的樣本再重測。
const OCR_NORMALIZE = false;
const NORMALIZE_SPREAD = 0.32;   // (p90-p10)/mean 超過這個值＝光線明顯不均

// 1/8 解析度估背景（成本是完整的 1/64），順便算亮度離散程度
function backgroundStats(gray, W, H) {
  const S = 8;
  const bw = Math.max(1, Math.ceil(W / S)), bh = Math.max(1, Math.ceil(H / S));
  const bg = new Float32Array(bw * bh);
  for (let v = 0; v < H; v++) {
    const by = (v / S) | 0;
    for (let u = 0; u < W; u++) bg[by * bw + ((u / S) | 0)] += gray[v * W + u];
  }
  const cell = S * S;
  let mean = 0;
  for (let i = 0; i < bg.length; i++) { bg[i] /= cell; mean += bg[i]; }
  mean /= Math.max(1, bg.length);
  const sorted = Float32Array.from(bg).sort();
  const p10 = sorted[Math.floor(sorted.length * 0.1)] || 0;
  const p90 = sorted[Math.floor(sorted.length * 0.9)] || 0;
  return { bg, bw, bh, mean, spread: (p90 - p10) / Math.max(1, mean) };
}

// 每個像素除以低頻背景：亮度差被壓平、筆畫保留
function normalizedGray(st, gray, W, H) {
  const { bw, bh, bg } = st;
  const r = 6;
  const tmp = new Float32Array(bg.length), blur = new Float32Array(bg.length);
  for (let y = 0; y < bh; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += bg[y * bw + Math.min(bw - 1, Math.max(0, x))];
    for (let x = 0; x < bw; x++) {
      tmp[y * bw + x] = sum / (2 * r + 1);
      sum += bg[y * bw + Math.min(bw - 1, x + r + 1)] - bg[y * bw + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < bw; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(bh - 1, Math.max(0, y)) * bw + x];
    for (let y = 0; y < bh; y++) {
      blur[y * bw + x] = sum / (2 * r + 1);
      sum += tmp[Math.min(bh - 1, y + r + 1) * bw + x] - tmp[Math.max(0, y - r) * bw + x];
    }
  }
  const out = new Uint8ClampedArray(W * H);
  for (let v = 0; v < H; v++) {
    const by = Math.min(bh - 1, (v / 8) | 0);
    for (let u = 0; u < W; u++) {
      const b = blur[by * bw + Math.min(bw - 1, (u / 8) | 0)] || 1;
      out[v * W + u] = (gray[v * W + u] / b) * 190;
    }
  }
  return out;
}

/* =============================================================
   格線偵測：找表格的直線與橫線，讓切欄切列不必靠空白去猜
   ============================================================= */
// 找格線前的局部對比校正：每個像素除以附近的平均亮度（背景）。
// detectLines 要求線比兩側暗 20 階；昏暗、低對比或半邊陰影的照片，淡格線差不到 20
// 就整條漏掉，切欄只能退回用空白猜。除以背景後，「比紙暗 x%」的線在亮處暗處一樣明顯。
// 只給找格線用，送進 OCR 的圖不動（調色、銳利化對辨識的影響要另外量，見 README）。
function normalizeForLines(gray, W, H) {
  const R = Math.max(8, Math.round(Math.max(W, H) / 30));   // 遠大於線寬與字的筆畫
  const W1 = W + 1, sum = new Uint32Array(W1 * (H + 1));   // 積分圖：任意方框的總和 O(1)
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += gray[y * W + x];
      sum[(y + 1) * W1 + x + 1] = sum[y * W1 + x + 1] + row;
    }
  }
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - R), y1 = Math.min(H, y + R + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - R), x1 = Math.min(W, x + R + 1);
      const s = sum[y1 * W1 + x1] - sum[y0 * W1 + x1] - sum[y1 * W1 + x0] + sum[y0 * W1 + x0];
      // 背景下限 48：全黑區域不是紙，別把雜訊放大成線
      const bg = Math.max(48, s / ((x1 - x0) * (y1 - y0)));
      out[y * W + x] = Math.min(255, gray[y * W + x] * 255 / bg);
    }
  }
  return out;
}

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
   跨格線的文字框：切開後各自重新辨識
   ============================================================= */
// 實拍常見：項次「1-1」右對齊、緊貼左對齊的科目「主持人費」，偵測器把整串框成
// 一個字（「1-1主持人費」）。這種框之後不管怎麼切欄都只會落在一欄，整張表從
// 這裡開始左右錯位。直接拿原圖沿格線切兩半各自辨識，比按字數硬切準得多。
function cropCanvas(canvas, x1, y1, x2, y2, scale = 2) {
  const sx = Math.max(0, Math.floor(x1)), sy = Math.max(0, Math.floor(y1));
  const sw = Math.max(1, Math.ceil(Math.min(canvas.width, x2) - sx));
  const sh = Math.max(1, Math.ceil(Math.min(canvas.height, y2) - sy));
  const c = new OffscreenCanvas(Math.max(1, Math.round(sw * scale)), Math.max(1, Math.round(sh * scale)));
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

async function recCrop(svc, canvas, x1, y1, x2, y2, scales = [2, 1]) {
  let best = null;
  for (const scale of scales) {
    const res = await svc.recognize(cropCanvas(canvas, x1, y1, x2, y2, scale), {
      flatten: true, minimumConfidence: 0, strategy: 'per-box',
    });
    const hits = res.results.filter((r) => r.text.trim()).sort((a, b) => b.confidence - a.confidence);
    best = hits[0] || best;
    if (best && best.confidence >= 0.85) break;   // 夠準就不必再試原尺寸
  }
  return best;
}

const CJK_G = /[\u4e00-\u9fff]/;

// 依「字寬」估算格線落在哪兩個字之間（中文 1、英數 0.55、標點 0.4）
function charUnits(ch) {
  if (/[\u2e80-\u9fff\uff01-\uff60]/.test(ch)) return 1;
  if (/[0-9a-zA-Z]/.test(ch)) return 0.55;
  if (/\s/.test(ch)) return 0.3;
  return 0.4;
}

function geometricSplit(text, frac) {
  const total = [...text].reduce((n, ch) => n + charUnits(ch), 0);
  const target = frac * total;
  let acc = 0, idx = 0;
  for (let i = 0; i < text.length; i++) {
    const w = charUnits(text[i]);
    if (acc + w / 2 > target) { idx = i; break; }
    acc += w;
    idx = i + 1;
  }
  if (idx <= 0 || idx >= text.length) return null;
  return [text.slice(0, idx), text.slice(idx)];
}

/* 信心偏低的字框，裁切放大後重辨識一次（預算 12 次）。
 * 只處理「原本就認得、但信心很低」的框；補救切出來的碎片不再重跑（它們已經重辨識過）。 */
async function reOcrWeakWords(canvas, results, svc) {
  const out = [];
  let budget = 12;
  for (const r of results) {
    // 只救「短片段」（單一個字／單一數字最容易讀錯，例如 1→人、1→二）；
    // 長字串重跑的風險是「主持人費3」這種多出一個字的結果，得不償失（實測）
    const weak = r.confidence < 0.6 && r.text.trim().length <= 3 && !r.rescued && budget > 0;
    if (!weak) { out.push(r); continue; }
    budget--;
    const pad = Math.max(2, r.box.height * 0.12);
    let hit = null;
    try {
      hit = await recCrop(svc, canvas,
        r.box.x - pad, r.box.y - pad,
        r.box.x + r.box.width + pad, r.box.y + r.box.height + pad, [3, 2]);
    } catch (err) { /* 失敗就用原結果 */ }
    // 只有「明顯更有把握、而且不是空白」才換掉原本的字
    if (hit?.text?.trim() && hit.confidence > r.confidence + 0.15 && hit.text.trim().length <= 3) {
      out.push({ ...r, text: hit.text, confidence: hit.confidence, reOcr: true });
    } else {
      out.push(r);
    }
  }
  return out;
}

async function splitStraddling(canvas, results, grid, svc) {
  const vLines = grid?.v || [];
  if (!vLines.length) return results;
  const squash = (t) => String(t || '').replace(/\s+/g, '');
  // 「1,234」「(500)」這種整格就是數字的不拆 —— 拆開會變成兩格假數字，整欄驗算就毀了
  const isNumeric = (t) => {
    const s = squash(t).replace(/[,，$%％()（）\-−－]/g, '');
    return s !== '' && /^[\d.]+$/.test(s) && !isNaN(Number(s));
  };
  const out = [];
  let budget = 24;   // 每次辨識最多補 24 次，避免大表格把時間吃掉
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const cy = r.box.y + r.box.height / 2;
    const cuts = vLines
      .map((l) => l.a + l.b * cy)
      .filter((x) => {
        const f = (x - r.box.x) / Math.max(1, r.box.width);
        return f > 0.12 && f < 0.88;
      });
    // 表格上方的標題（例如「113年度…明細表」）不在表格裡，橫線以上不要拆
    const tableTop = grid?.h?.length ? Math.min(...grid.h.map((l) => l.a + l.b * (r.box.x + r.box.width / 2))) : -Infinity;
    if (cy < tableTop) { out.push(r); continue; }
    if (!cuts.length || r.text.trim().length < 2 || isNumeric(r.text) || budget <= 0) { out.push(r); continue; }

    const x = cuts[0];
    // 「項次＋科目」被框成一個字時，文字本身就會說話：「1人事費」＝代號 1 ／ 科目 人事費。
    // 這種前綴代號（數字、字母、1-1 形式）後面接中文的，直接依文繞切，比依框寬比例準：
    // 偵測框的 padding 讓框的左緣離文字很遠，按比例切常常把「1」跟「人」切在一起。
    const codeSplit = r.text.match(/^([0-9０-９A-Za-z][0-9０-９A-Za-z\-./]{0,3})\s*([\u4e00-\u9fff][\s\S]*)$/);
    // 再確認一次「線的位置」與「代號該佔的寬度」不要差太遠，避免把「2024年報」這種切開
    const codeFrac = codeSplit ? charUnits(codeSplit[1]) / Math.max(1, [...r.text].reduce((n, ch) => n + charUnits(ch), 0)) : 0;
    const fracNow = (x - r.box.x) / Math.max(1, r.box.width);
    // 代號本身就是數字（「1人事費」的 1、項次欄的 2），所以不能沿用「整格是數字就不拆」那條
    if (codeSplit && Math.abs(fracNow - codeFrac) < 0.45) {
      out.push({ ...r, text: codeSplit[1], rescued: true, box: { ...r.box, width: x - r.box.x } },
        { ...r, text: codeSplit[2], rescued: true, box: { ...r.box, x, width: r.box.x + r.box.width - x } });
      continue;
    }
    // 先用字寬比例快速切一次：像「1-1主 → 1-1 ／ 主」這種看得出來的，
    // 就不必再花時間跑兩次辨識（乾淨掃描件大多是這種）
    const frac = (x - r.box.x) / Math.max(1, r.box.width);
    const cheap = geometricSplit(r.text, frac);
    if (cheap && /^[\dA-Za-z\-.,()\/]+$/.test(cheap[0]) && cheap[0].length <= 6) {
      out.push({ ...r, text: cheap[0], rescued: true, box: { ...r.box, width: x - r.box.x } },
        { ...r, text: cheap[1], rescued: true, box: { ...r.box, x, width: r.box.x + r.box.width - x } });
      continue;
    }
    // 這裡刻意「每一框都補救」，不依「這一列字框數夠不夠」省略：
    // 會跨線的框本來就是該補救的那幾個，省掉它換到的是整表錯位的代價。
    // （實測：省略後模糊實拍 9s → 6s，但格級正確率 81.5% → 69.2%）
    const pad = r.box.height * 0.25;
    const y1 = r.box.y - pad, y2 = r.box.y + r.box.height + pad;
    // 用格線（而不是偵測框的邊）決定裁切範圍：偵測框的 padding 會把隔壁的字含進來，
    // 單邊裁切就會多認出一個字（「1」被讀成「1人」）
    const sorted = vLines.map((l) => l.a + l.b * cy).sort((m, n) => m - n);
    const leftEdge = Math.max(r.box.x - 2, ...[...sorted].filter((v) => v < x - 2).slice(-1));
    const rightEdge = Math.min(r.box.x + r.box.width + 2, ...[...sorted].filter((v) => v > x + 2).slice(0, 1));
    const rightBound = Number.isFinite(rightEdge) ? rightEdge : r.box.x + r.box.width + 2;
    budget -= 2;
    // 同一時間只跑一次 recognize：服務內部共用同一個 session，平行呼叫會拿到空結果
    let left = null, right = null;
    try {
      left = await recCrop(svc, canvas, leftEdge, y1, x - 2, y2);
      right = await recCrop(svc, canvas, x + 2, y1, rightBound, y2);
    } catch (err) { /* 補救只是加分，失敗就保留原框 */ }

    // 單一個字的裁切常常辨識不出來（「主」「業」）：只要一邊認得、又是原字串的
    // 開頭/結尾，另一邊就用剩下的字補齊。兩邊拼不回來原字串就整筆放棄。
    const whole = squash(r.text);
    let L = left?.text ? squash(left.text) : null;
    let R = right?.text ? squash(right.text) : null;
    if (L && !R && whole.startsWith(L)) R = whole.slice(L.length) || null;
    else if (!L && R && whole.endsWith(R)) L = whole.slice(0, whole.length - R.length) || null;
    if (!L || !R || L + R !== whole) { out.push(r); continue; }
    // 拆出單一個中文字、右邊又接著中文：這是同一個詞被雜線切開（陰影、紙緣），不是兩格
    if (L.length === 1 && CJK_G.test(L) && CJK_G.test(R[0])) { out.push(r); continue; }

    out.push(
      { ...r, text: left?.text || L, confidence: left?.confidence ?? r.confidence, rescued: true,
        box: { ...r.box, width: x - r.box.x } },
      { ...r, text: right?.text || R, confidence: right?.confidence ?? r.confidence, rescued: true,
        box: { ...r.box, x, width: r.box.x + r.box.width - x } },
    );
  }
  return out;
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
    let canvas, grid = null, rectRef = null, ocrNormalized = false;
    try {
      const rect = rectifiedCanvas(bitmap, msg.quad);
      rectRef = rect;          // rect 原本是 try 區塊內的 const，外面拿不到（縮圖要用）
      canvas = rect.canvas;
      if (OCR_NORMALIZE) {
        // 只換送 OCR 的那一份；canvas 仍保留原始灰階，縮圖對照才不會看起來「被洗白」。
        // 先看光線分佈：乾淨截圖不套（量測顯示會掉 1~3 格）
        const st = backgroundStats(rect.gray, rect.width, rect.height);
        ocrNormalized = st.spread > NORMALIZE_SPREAD;
        const norm = ocrNormalized ? normalizedGray(st, rect.gray, rect.width, rect.height) : null;
        if (norm) {
          const nc = new OffscreenCanvas(rect.width, rect.height);
          const ng = nc.getContext('2d');
          const img = ng.createImageData(rect.width, rect.height);
          for (let i = 0, o = 0; i < norm.length; i++, o += 4) {
            img.data[o] = img.data[o + 1] = img.data[o + 2] = norm[i];
            img.data[o + 3] = 255;
          }
          ng.putImageData(img, 0, 0);
          canvas = nc;
        }
      }
      try {
        const lineGray = normalizeForLines(rect.gray, rect.width, rect.height);
        grid = {
          v: detectLines(lineGray, rect.width, rect.height, true),
          h: detectLines(lineGray, rect.width, rect.height, false),
        };
      } catch (err) { /* 格線只是輔助，失敗就照舊用空白切欄 */ }
    } finally { bitmap.close(); }
    // per-box：逐框辨識。預設逐行合併遇到歪斜 2° 以上的照片會整張讀成亂碼
    const res = await svc.recognize(canvas, {
      flatten: true,
      minimumConfidence: 0,
      strategy: 'per-box',
    });
    // 跨格線的字框先切開重辨識，後面的切欄才不會從這裡歪掉
    let words = res.results;
    try { words = await splitStraddling(canvas, res.results, grid, svc); } catch (err) { /* 補救失敗就用原結果 */ }
    // 認得但很沒把握的字（單一個「1」被讀成「人」這種），放大後再認一次
    try { words = await reOcrWeakWords(canvas, words, svc); } catch (err) { /* 失敗就用原結果 */ }
    const confidence = words.length
      ? words.reduce((a, r) => a + r.confidence, 0) / words.length
      : 1;
    const results = words
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
    // 轉正後的縮圖（ImageBitmap，跨執行緒免拷貝）：主執行緒用它畫「點某格 → 放大原圖對照」。
    // 只在記憶體裡存在，不上傳、不落地。
    let preview = null, previewScale = 1;
    try {
      if (!rectRef) throw new Error('no rect');
      const maxDim = 1600;
      const k = Math.min(1, maxDim / Math.max(rectRef.width, rectRef.height));
      const pw = Math.max(1, Math.round(rectRef.width * k)), ph = Math.max(1, Math.round(rectRef.height * k));
      const pc = new OffscreenCanvas(pw, ph);
      const pg = pc.getContext('2d');
      pg.imageSmoothingQuality = 'high';
      pg.drawImage(rectRef.canvas, 0, 0, pw, ph);
      // 用 Blob 而不是 transferToImageBitmap：後者在部分 Chrome／WebGPU 組合下不支援
      preview = await pc.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      previewScale = pw / rectRef.width;   // 原圖 px → 縮圖 px
    } catch (err) { preview = null; }
    self.postMessage({ type: 'result', id, confidence, results, grid, preview, previewScale,
      normalized: ocrNormalized, backend: { ocr: serviceBackend, layout: layoutBackend() } });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err?.message || err) });
  }
};
