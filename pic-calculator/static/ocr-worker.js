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
const MIN_CONFIDENCE = 0.3;
const MIN_NUMERIC_CONFIDENCE = 0.2;
// 轉正後畫布的最長邊。試過拉到 3200（想保留更多小字細節），實測反而退步
// （格級 97.4% → 96.6%、數字格 97.6% → 97.0%，還慢一倍）：PP-OCR 的偵測在
// 過大的圖上會把字切得更碎。維持 2560。
const RECT_MAX_SIDE = 2560;
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

function toHalfWidthNumeric(s) {
  return s
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[－−—–]/g, '-')
    .replace(/．/g, '.');
}

function repairNumericToken(s) {
  // 僅在明顯為數字儲存格（含至少一位數字，且不含一般文字）時修正常見混淆字元
  if (!/\d/.test(s) || !/^[\d.,\-+$%()OolI|〇\s]+$/.test(s)) return s;
  return s
    .replace(/[Oo〇]/g, '0')
    .replace(/[lI|]/g, '1');
}

function cleanText(t) {
  const s = repairNumericToken(toHalfWidthNumeric(toTraditional(t.trim())));
  return s
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
  if (!ort.env.wasm.wasmPaths) {
    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
  }
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  layoutSession = await createLayoutSession(['wasm']);
  layoutEps = ['wasm'];
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
    try { layoutSession.release?.()?.catch?.(() => {}); } catch (releaseErr) { /* 忽略 */ }
    layoutSession = await createLayoutSession(['wasm']);
    layoutEps = ['wasm'];
    return await layoutSession.run(makeInputs());
  }
}

async function detectTable(bitmap) {
  const N = 480, W = bitmap.width, H = bitmap.height;
  // 等比例縮放（Letterbox 補灰邊）保留原始長寬比，避免直拍長圖被壓扁影響偵測
  const scale = Math.min(N / W, N / H);
  const rw = Math.round(W * scale), rh = Math.round(H * scale);
  const canvas = new OffscreenCanvas(N, N);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, N, N);
  ctx.drawImage(bitmap, 0, 0, rw, rh);
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
    scale_factor: new ort.Tensor('float32', [scale, scale], [1, 2]),
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

function estimatePaperBackground(data, w, h) {
  const ds = Math.max(1, Math.round(Math.max(w, h) / 160));
  const sw = Math.max(1, Math.ceil(w / ds));
  const sh = Math.max(1, Math.ceil(h / ds));
  const lum = new Float32Array(sw * sh);
  for (let sy = 0; sy < sh; sy++) {
    const y = Math.min(h - 1, sy * ds);
    for (let sx = 0; sx < sw; sx++) {
      const x = Math.min(w - 1, sx * ds);
      const o = (y * w + x) * 4;
      lum[sy * sw + sx] = data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
    }
  }
  // 2D separable max filter (radius 6) 估計紙張底色，避免被深色文字拉低
  const rMax = 6;
  const maxH = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    const row = y * sw;
    for (let x = 0; x < sw; x++) {
      let m = 0;
      const x0 = Math.max(0, x - rMax), x1 = Math.min(sw - 1, x + rMax);
      for (let k = x0; k <= x1; k++) if (lum[row + k] > m) m = lum[row + k];
      maxH[row + x] = m;
    }
  }
  const maxV = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    const y0 = Math.max(0, y - rMax), y1 = Math.min(sh - 1, y + rMax);
    for (let x = 0; x < sw; x++) {
      let m = 0;
      for (let k = y0; k <= y1; k++) {
        const v = maxH[k * sw + x];
        if (v > m) m = v;
      }
      maxV[y * sw + x] = m;
    }
  }
  // 2D separable box blur (radius 4) 平滑背景圖
  const rBlur = 4;
  const blurH = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    const row = y * sw;
    for (let x = 0; x < sw; x++) {
      let sum = 0, cnt = 0;
      const x0 = Math.max(0, x - rBlur), x1 = Math.min(sw - 1, x + rBlur);
      for (let k = x0; k <= x1; k++) { sum += maxV[row + k]; cnt++; }
      blurH[row + x] = sum / cnt;
    }
  }
  const bg = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    const y0 = Math.max(0, y - rBlur), y1 = Math.min(sh - 1, y + rBlur);
    for (let x = 0; x < sw; x++) {
      let sum = 0, cnt = 0;
      for (let k = y0; k <= y1; k++) { sum += blurH[k * sw + x]; cnt++; }
      bg[y * sw + x] = sum / cnt;
    }
  }
  return { bg, sw, sh, ds };
}

function normalizeAndSharpen(data, w, h) {
  const { bg, sw, sh, ds } = estimatePaperBackground(data, w, h);
  // 確認為淺底文件（避免深色背景截圖被過度提亮）
  const sorted = Float32Array.from(bg).sort();
  const medianBg = sorted[sorted.length >> 1] || 0;
  if (medianBg > 100) {
    for (let y = 0; y < h; y++) {
      const sy = Math.min(sh - 1, (y / ds) | 0);
      for (let x = 0; x < w; x++) {
        const sx = Math.min(sw - 1, (x / ds) | 0);
        const bgVal = bg[sy * sw + sx];
        if (bgVal <= 40) continue;
        const gain = Math.min(2.2, 238 / bgVal);
        const o = (y * w + x) * 4;
        data[o] = Math.min(255, data[o] * gain);
        data[o + 1] = Math.min(255, data[o + 1] * gain);
        data[o + 2] = Math.min(255, data[o + 2] * gain);
      }
    }
  }
  // 輕微 3×3 Unsharp Mask 銳化筆畫邊緣
  if (w < 3 || h < 3) return;
  const copy = new Uint8ClampedArray(data);
  const a = 0.12; // 銳化強度 (4*a = 0.48)
  const cWeight = 1 + 4 * a;
  const stride = w * 4;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const o = y * stride + x * 4;
      for (let ch = 0; ch < 3; ch++) {
        const v = copy[o + ch] * cWeight
          - (copy[o - 4 + ch] + copy[o + 4 + ch] + copy[o - stride + ch] + copy[o + stride + ch]) * a;
        data[o + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
}

function rectifiedCanvas(bitmap, quad) {
  const q = Array.isArray(quad) && quad.length === 4 ? quad : FULL_QUAD;
  const s0 = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
  const W = Math.round(bitmap.width * s0), H = Math.round(bitmap.height * s0);
  const src = new OffscreenCanvas(W, H);
  const sg = src.getContext('2d', { willReadFrequently: true });
  sg.drawImage(bitmap, 0, 0, W, H);
  const rgba = sg.getImageData(0, 0, W, H).data;

  const pts = orderPoints(q.map(([x, y]) => [x * (W - 1), y * (H - 1)]));
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w0 = Math.max(dist(pts[0], pts[1]), dist(pts[3], pts[2]), 1);
  const h0 = Math.max(dist(pts[0], pts[3]), dist(pts[1], pts[2]), 1);
  const scale = Math.min(3, RECT_MAX_SIDE / Math.max(w0, h0));
  const dw = Math.round(w0 * scale), dh = Math.round(h0 * scale);
  const m = homography(dw - 1, dh - 1, pts);

  const out = new OffscreenCanvas(dw, dh);
  const og = out.getContext('2d', { willReadFrequently: true });
  const id = og.createImageData(dw, dh), d = id.data;
  const outGray = new Uint8Array(dw * dh);   // 給格線偵測用
  for (let v = 0, o = 0; v < dh; v++) {
    for (let u = 0; u < dw; u++, o += 4) {
      const z = m[6] * u + m[7] * v + 1;
      const x = Math.min(W - 1.001, Math.max(0, (m[0] * u + m[1] * v + m[2]) / z));
      const y = Math.min(H - 1.001, Math.max(0, (m[3] * u + m[4] * v + m[5]) / z));
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
      const p00 = (y0 * W + x0) * 4, p10 = p00 + 4, p01 = p00 + W * 4, p11 = p01 + 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = rgba[p00 + ch] + (rgba[p10 + ch] - rgba[p00 + ch]) * fx;
        const bot = rgba[p01 + ch] + (rgba[p11 + ch] - rgba[p01 + ch]) * fx;
        d[o + ch] = top + (bot - top) * fy;
      }
      d[o + 3] = 255;
    }
  }
  normalizeAndSharpen(d, dw, dh);
  for (let i = 0, o = 0; i < outGray.length; i++, o += 4) {
    outGray[i] = d[o] * 0.299 + d[o + 1] * 0.587 + d[o + 2] * 0.114;
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

async function refineLowConfidenceBoxes(svc, canvas, rawResults) {
  const candidates = rawResults
    .filter((r) => {
      const t = r.text.trim();
      return t && r.confidence >= MIN_NUMERIC_CONFIDENCE && r.confidence < 0.8 && (/[\d]/.test(t) || /^[-.,]+$/.test(t));
    })
    .slice(0, 12);
  if (!candidates.length) return;

  for (const r of candidates) {
    const { x, y, width: w, height: h } = r.box;
    if (w < 4 || h < 4) continue;
    const pad = Math.max(4, Math.round(Math.min(w, h) * 0.35));
    const sx = Math.max(0, Math.floor(x - pad));
    const sy = Math.max(0, Math.floor(y - pad));
    const sw = Math.min(canvas.width - sx, Math.ceil(w + pad * 2));
    const sh = Math.min(canvas.height - sy, Math.ceil(h + pad * 2));
    if (sw < 6 || sh < 6) continue;

    const crop = new OffscreenCanvas(sw * 2, sh * 2);
    const cg = crop.getContext('2d', { willReadFrequently: true });
    cg.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw * 2, sh * 2);
    // 局部對比拉伸，強化模糊數字筆畫
    const id = cg.getImageData(0, 0, crop.width, crop.height);
    const d = id.data;
    let lo = 255, hi = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      if (lum < lo) lo = lum;
      if (lum > hi) hi = lum;
    }
    if (hi - lo > 20 && hi - lo < 220) {
      const span = hi - lo;
      for (let i = 0; i < d.length; i += 4) {
        for (let ch = 0; ch < 3; ch++) {
          const v = ((d[i + ch] - lo) * 255) / span;
          d[i + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
      cg.putImageData(id, 0, 0);
    }

    try {
      const sub = await svc.recognize(crop, { flatten: true, minimumConfidence: 0, strategy: 'per-box' });
      const best = sub.results?.filter((sr) => sr.text.trim()).sort((a, b) => b.confidence - a.confidence)[0];
      if (best && best.confidence > r.confidence) {
        r.text = best.text;
        r.confidence = best.confidence;
      }
    } catch (err) { /* 局部重辨識失敗則保留原結果 */ }
  }
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
   表格結構模式（PP-Structure SLANet，models/slanet_plus.onnx）
   =============================================================
   只給「幾乎沒有內部格線」的表格用：沒有線就沒有欄界，靠空白帶猜的結果實測只有
   23% 格正確（數字格 0%）。結構模型直接給出「有哪些格子、各在哪裡」，把 OCR 的字框
   依座標塞進去即可，不必再猜。

   解碼規則照 PaddleOCR 官方 TableLabelDecode（merge_no_span_structure=True）：
   字典把 `<td>` 換成 `<td></td>`、最前加上 sos、最後是 eos；sos 是座標佔位符要跳過，
   `<td` 與 `<td></td>` 這兩個 token 才帶 8 個座標（四點多邊形，0～1 正規化）。
   驗證紀錄見 bench/experiments/SLANET_FINDINGS.md（真瀏覽器 15／20 格全過、推論約 310ms）。
*/
const TABLE_STRUCTURE_MODEL = 'models/slanet_plus.onnx';
const TABLE_VOCAB = [
  "sos",
  "<thead>",
  "</thead>",
  "<tbody>",
  "</tbody>",
  "<tr>",
  "</tr>",
  "<td",
  ">",
  "</td>",
  " colspan=\"2\"",
  " colspan=\"3\"",
  " colspan=\"4\"",
  " colspan=\"5\"",
  " colspan=\"6\"",
  " colspan=\"7\"",
  " colspan=\"8\"",
  " colspan=\"9\"",
  " colspan=\"10\"",
  " colspan=\"11\"",
  " colspan=\"12\"",
  " colspan=\"13\"",
  " colspan=\"14\"",
  " colspan=\"15\"",
  " colspan=\"16\"",
  " colspan=\"17\"",
  " colspan=\"18\"",
  " colspan=\"19\"",
  " colspan=\"20\"",
  " rowspan=\"2\"",
  " rowspan=\"3\"",
  " rowspan=\"4\"",
  " rowspan=\"5\"",
  " rowspan=\"6\"",
  " rowspan=\"7\"",
  " rowspan=\"8\"",
  " rowspan=\"9\"",
  " rowspan=\"10\"",
  " rowspan=\"11\"",
  " rowspan=\"12\"",
  " rowspan=\"13\"",
  " rowspan=\"14\"",
  " rowspan=\"15\"",
  " rowspan=\"16\"",
  " rowspan=\"17\"",
  " rowspan=\"18\"",
  " rowspan=\"19\"",
  " rowspan=\"20\"",
  "<td></td>",
  "eos"
];
const TABLE_TD_TOKENS = new Set(['<td', '<td></td>']);
let structureSession = null, structureUnavailable = false;

async function getStructureSession() {
  if (structureSession) return structureSession;
  if (structureUnavailable) return null;
  // 先用 WASM 建立（實測 WASM 304ms、推論 310ms；WebGPU 對這顆含 Loop 的圖沒有好處，
  // 而且 WebGPU 初始化在 worker 裡可能卡住）
  try {
    structureSession = await ort.InferenceSession.create(TABLE_STRUCTURE_MODEL, {
      executionProviders: ['wasm'],
      logSeverityLevel: 3,
    });
  } catch (err) {
    try {
      structureSession = await ort.InferenceSession.create(TABLE_STRUCTURE_MODEL, {
        executionProviders: await getDefaultWebExecutionProviders(),
      });
    } catch (err2) {
      structureUnavailable = true;
      postStatus('表格結構模型載入失敗，改用格線判斷');
      return null;
    }
  }
  return structureSession;
}

// 488×488、BGR、ImageNet 正規化、右下補 0（PaddleOCR 的順序：先正規化再補）
function structureInput(canvas) {
  const N = 488;
  const ratio = Math.min(1, N / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * ratio));
  const h = Math.max(1, Math.round(canvas.height * ratio));
  const scaled = new OffscreenCanvas(w, h);
  const g = scaled.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const data = new Float32Array(3 * N * N);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4, d = y * N + x;
      for (let ch = 0; ch < 3; ch++) {
        const src = ch === 0 ? p + 2 : ch === 2 ? p : p + 1;   // BGR
        data[ch * N * N + d] = (px[src] / 255 - mean[ch]) / std[ch];
      }
    }
  }
  return new ort.Tensor('float32', data, [1, 3, N, N]);
}

/* 解結構 token：模型輸出的序列本身就帶了列與格
   （`<tr>` 開一列、`<td`／`<td></td>` 一格、` colspan="N"`／` rowspan="N"` 是合併資訊）。
   直接照序列建表，不必再對座標做分群 —— 分群很吃容忍度，實測 5 欄會被拆成 8～32 欄。 */
function structureRows(loc, probs, canvasW, canvasH) {
  const rows = [];
  let curRow = null, curCell = null;
  const T = probs.dims[1], V = probs.dims[2];
  for (let t = 0; t < T; t++) {
    let best = 0, bestP = -Infinity;
    for (let v = 0; v < V; v++) {
      const p = probs.data[t * V + v];
      if (p > bestP) { bestP = p; best = v; }
    }
    const token = TABLE_VOCAB[best];
    if (token === 'eos') break;
    if (token === 'sos') continue;
    if (token === '<tr>') { curRow = []; rows.push(curRow); curCell = null; continue; }
    if (token === '</tr>') { curRow = null; curCell = null; continue; }
    if (token === '<thead>' || token === '</thead>' || token === '<tbody>' || token === '</tbody>') continue;
    if (TABLE_TD_TOKENS.has(token)) {
      if (!curRow) { curRow = []; rows.push(curRow); }
      const o = t * 8, xs = [], ys = [];
      for (let k = 0; k < 4; k++) {
        xs.push(Math.min(1, Math.max(0, loc.data[o + k * 2])) * canvasW);
        ys.push(Math.min(1, Math.max(0, loc.data[o + k * 2 + 1])) * canvasH);
      }
      curCell = {
        x1: Math.min(...xs), x2: Math.max(...xs),
        y1: Math.min(...ys), y2: Math.max(...ys),
        colspan: 1, rowspan: 1, text: '', score: 1,
      };
      curRow.push(curCell);
      continue;
    }
    const span = /^(?:rowspan|colspan)="(\d+)"$/.exec(token.replace(/^ /, ''));
    if (span && curCell) {
      if (token.startsWith(' colspan')) curCell.colspan = Math.max(1, +span[1]);
      else curCell.rowspan = Math.max(1, +span[1]);
    }
  }
  return rows.filter((r) => r.length);
}

/* 把 token 序列排成真正的格子表：colspan 佔多欄、rowspan 佔多列。
   排列時要「跳過已經被上面列 rowspan 佔走的位置」，否則後面的列會整排左移。 */
function rowsToTable(rows, words) {
  if (!rows.length) return null;
  const nrow = rows.length;
  const occupied = [];                       // occupied[r][c] = true 表示被合併格佔用
  const cells = [];
  let ncol = 1;
  const isFree = (r, c) => !(occupied[r] && occupied[r][c]);

  rows.forEach((row, r) => {
    let c = 0;
    for (const cell of row) {
      while (!isFree(r, c)) c++;             // 跳過被 rowspan 佔用的位置
      const cs = Math.max(1, Math.min(cell.colspan, 20));
      const rs = Math.max(1, Math.min(cell.rowspan, nrow - r));
      for (let dr = 0; dr < rs; dr++) {
        const rr = r + dr;
        occupied[rr] = occupied[rr] || [];
        for (let dc = 0; dc < cs; dc++) occupied[rr][c + dc] = true;
      }
      cells.push({ ...cell, r, c, colspan: cs, rowspan: rs,
        area: Math.max(1, (cell.x2 - cell.x1) * (cell.y2 - cell.y1)) });
      ncol = Math.max(ncol, c + cs);
      c += cs;
    }
  });

  const grid = Array.from({ length: nrow }, () => new Array(ncol).fill(''));
  const conf = Array.from({ length: nrow }, () => new Array(ncol).fill(1));
  const boxes = Array.from({ length: nrow }, () => new Array(ncol).fill(null));
  const spans = Array.from({ length: nrow }, () => new Array(ncol).fill(null));
  for (const cell of cells) {
    spans[cell.r][cell.c] = { rs: cell.rowspan, cs: cell.colspan };
    boxes[cell.r][cell.c] = { x1: cell.x1, y1: cell.y1, x2: cell.x2, y2: cell.y2 };
  }

  // 合併儲存格面積較大，字框先找「面積最小又包含它」的那一格
  const ordered = [...cells].sort((a, b) => a.area - b.area);
  for (const w of words) {
    let hit = null;
    for (const cell of ordered) {
      if (w.cx >= cell.x1 && w.cx <= cell.x2 && w.cy >= cell.y1 && w.cy <= cell.y2) { hit = cell; break; }
    }
    // 模型的格子常比實際文字框小一點（尤其最左欄），落在格子外的字不要丟掉 ——
    // 只救「垂直方向還在同一列、只是稍微偏出左右邊界」的字；
    // 允許垂直偏移會讓隔壁列的字被吸上來（實測併成「1人事費1-1主持人費」）
    if (!hit) {
      const ySlack = Math.max(4, (w.h || 20) * 0.25);
      let best = null, bestDx = Infinity;
      for (const cell of cells) {
        const dy = Math.max(cell.y1 - w.cy, 0, w.cy - cell.y2);
        if (dy > ySlack) continue;
        const dx = Math.max(cell.x1 - w.cx, 0, w.cx - cell.x2);
        if (dx < bestDx) { bestDx = dx; best = cell; }
      }
      if (best && bestDx <= Math.max(12, (w.h || 20) * 0.8)) hit = best;
    }
    if (!hit) continue;
    grid[hit.r][hit.c] = grid[hit.r][hit.c] ? grid[hit.r][hit.c] + ' ' + w.text : w.text;
    conf[hit.r][hit.c] = Math.min(conf[hit.r][hit.c], Number.isFinite(w.score) ? w.score : 1);
  }
  // 去掉頭尾整列／整欄空白（模型偶爾會多吐一列標題或最右邊的細欄）
  const rowEmpty = (r) => grid[r].every((t) => !t) && spans[r].every((sp) => !sp);
  const colEmpty = (c) => grid.every((row) => !row[c]) && spans.every((row) => !row[c]);
  while (grid.length > 1 && rowEmpty(0)) { grid.shift(); conf.shift(); boxes.shift(); spans.shift(); }
  while (grid.length > 1 && rowEmpty(grid.length - 1)) { grid.pop(); conf.pop(); boxes.pop(); spans.pop(); }
  while (ncol > 1 && colEmpty(ncol - 1)) {
    grid.forEach((r) => r.pop()); conf.forEach((r) => r.pop());
    boxes.forEach((r) => r.pop()); spans.forEach((r) => r.pop());
    ncol--;
  }
  return { grid, conf, boxes, spans, cells: cells.length, rows: grid.length, cols: ncol };
}

const TATR_MODEL = 'https://huggingface.co/Xenova/table-transformer-structure-recognition-v1.1-fin/resolve/main/onnx/model_quantized.onnx';
let tatrSession = null, tatrUnavailable = false;

async function getTatrSession() {
  if (tatrSession) return tatrSession;
  if (tatrUnavailable) return null;
  try {
    tatrSession = await ort.InferenceSession.create(TATR_MODEL, {
      executionProviders: ['wasm'],
      logSeverityLevel: 3,
    });
  } catch (err) {
    tatrUnavailable = true;
    return null;
  }
  return tatrSession;
}

function nms1D(items, startKey, endKey, iouThresh = 0.5) {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const item of sorted) {
    const lenA = Math.max(1, item[endKey] - item[startKey]);
    const overlap = kept.some((k) => {
      const inter = Math.max(0, Math.min(item[endKey], k[endKey]) - Math.max(item[startKey], k[startKey]));
      const lenB = Math.max(1, k[endKey] - k[startKey]);
      return inter / (lenA + lenB - inter) > iouThresh;
    });
    if (!overlap) kept.push(item);
  }
  return kept.sort((a, b) => a[startKey] - b[startKey]);
}

async function tatrTable(canvas, words) {
  const sess = await getTatrSession();
  if (!sess) return null;
  postStatus('沒有明顯格線，改用財報表格結構模型 (TATR)…');

  const maxSide = 1000;
  const ratio = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * ratio));
  const h = Math.max(1, Math.round(canvas.height * ratio));
  const scaled = new OffscreenCanvas(w, h);
  const g = scaled.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;

  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const data = new Float32Array(3 * h * w);
  for (let i = 0; i < w * h; i++) {
    for (let ch = 0; ch < 3; ch++) {
      data[ch * w * h + i] = (px[i * 4 + ch] / 255 - mean[ch]) / std[ch];
    }
  }
  const feeds = { pixel_values: new ort.Tensor('float32', data, [1, 3, h, w]) };
  if (sess.inputNames.includes('pixel_mask')) {
    const mask = new BigInt64Array(h * w).fill(1n);
    feeds.pixel_mask = new ort.Tensor('int64', mask, [1, h, w]);
  }

  const out = await sess.run(feeds);
  const logits = out.logits || Object.values(out).find((t) => t.dims.length === 3 && t.dims[2] === 7);
  const predBoxes = out.pred_boxes || Object.values(out).find((t) => t.dims.length === 3 && t.dims[2] === 4);
  if (!logits || !predBoxes) return null;

  const Q = logits.dims[1], C = logits.dims[2];
  const rawCols = [], rawRows = [], rawSpans = [];
  for (let q = 0; q < Q; q++) {
    const base = q * C;
    let maxL = -Infinity;
    for (let c = 0; c < C; c++) if (logits.data[base + c] > maxL) maxL = logits.data[base + c];
    let sumExp = 0;
    const probs = new Float32Array(C);
    for (let c = 0; c < C; c++) { probs[c] = Math.exp(logits.data[base + c] - maxL); sumExp += probs[c]; }
    let bestC = 0, bestP = 0;
    for (let c = 0; c < C; c++) {
      const p = probs[c] / sumExp;
      if (p > bestP) { bestP = p; bestC = c; }
    }
    if (bestC === 6) continue; // no-object
    const [cx, cy, bw, bh] = predBoxes.data.subarray(q * 4, q * 4 + 4);
    const box = {
      x1: Math.max(0, cx - bw / 2) * canvas.width,
      y1: Math.max(0, cy - bh / 2) * canvas.height,
      x2: Math.min(1, cx + bw / 2) * canvas.width,
      y2: Math.min(1, cy + bh / 2) * canvas.height,
      score: bestP,
    };
    if (bestC === 1 && bestP >= 0.5) rawCols.push(box);
    else if (bestC === 2 && bestP >= 0.5) rawRows.push(box);
    else if (bestC === 5 && bestP >= 0.6) rawSpans.push(box);
  }

  const cols = nms1D(rawCols, 'x1', 'x2', 0.45);
  const rows = nms1D(rawRows, 'y1', 'y2', 0.45);
  if (rows.length < 2 || cols.length < 2) return null;

  const nrow = rows.length, ncol = cols.length;
  const grid = Array.from({ length: nrow }, () => new Array(ncol).fill(''));
  const conf = Array.from({ length: nrow }, () => new Array(ncol).fill(1));
  const boxes = Array.from({ length: nrow }, (_, r) =>
    Array.from({ length: ncol }, (__, c) => ({ x1: cols[c].x1, y1: rows[r].y1, x2: cols[c].x2, y2: rows[r].y2 }))
  );
  const spans = Array.from({ length: nrow }, () => new Array(ncol).fill(null));
  const owner = Array.from({ length: nrow }, () => new Array(ncol).fill(null));

  for (const sp of rawSpans) {
    const rIdx = [], cIdx = [];
    rows.forEach((row, r) => {
      const ry = (row.y1 + row.y2) / 2;
      if (ry >= sp.y1 && ry <= sp.y2) rIdx.push(r);
    });
    cols.forEach((col, c) => {
      const cx = (col.x1 + col.x2) / 2;
      if (cx >= sp.x1 && cx <= sp.x2) cIdx.push(c);
    });
    if (rIdx.length && cIdx.length && (rIdx.length > 1 || cIdx.length > 1)) {
      const r0 = rIdx[0], c0 = cIdx[0];
      spans[r0][c0] = { rs: rIdx.length, cs: cIdx.length };
      for (const r of rIdx) for (const c of cIdx) owner[r][c] = [r0, c0];
    }
  }
  for (let r = 0; r < nrow; r++) {
    for (let c = 0; c < ncol; c++) {
      if (!owner[r][c]) spans[r][c] = { rs: 1, cs: 1 };
    }
  }

  const findBestBand = (bands, startKey, endKey, pt) => {
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < bands.length; i++) {
      if (pt >= bands[i][startKey] && pt <= bands[i][endKey]) return i;
      const mid = (bands[i][startKey] + bands[i][endKey]) / 2;
      const d = Math.abs(pt - mid);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  };

  for (const word of words) {
    const r = findBestBand(rows, 'y1', 'y2', word.cy);
    // 若單一字框橫跨多個 TATR 欄位且非合併儲存格，依空白拆詞並按比例分配到各欄
    const hitCols = [];
    for (let c = 0; c < ncol; c++) {
      const ov = Math.min(word.x2, cols[c].x2) - Math.max(word.x1, cols[c].x1);
      if (ov > Math.max(6, (word.h || 20) * 0.3)) hitCols.push(c);
    }
    const tokens = word.text.trim().split(/\s+/);
    if (hitCols.length > 1 && tokens.length >= hitCols.length && !owner[r][hitCols[0]]) {
      const totalChars = Math.max(1, word.text.length);
      let cursor = 0;
      for (const tok of tokens) {
        const idx = word.text.indexOf(tok, cursor);
        const midFrac = ((idx >= 0 ? idx : cursor) + tok.length / 2) / totalChars;
        const tokCx = word.x1 + (word.x2 - word.x1) * midFrac;
        cursor = (idx >= 0 ? idx : cursor) + tok.length;
        let c = findBestBand(cols, 'x1', 'x2', tokCx);
        let rr = r;
        if (owner[rr][c]) [rr, c] = owner[rr][c];
        grid[rr][c] = grid[rr][c] ? grid[rr][c] + ' ' + tok : tok;
        conf[rr][c] = Math.min(conf[rr][c], Number.isFinite(word.score) ? word.score : 1);
      }
      continue;
    }
    let c = findBestBand(cols, 'x1', 'x2', word.cx);
    let rr = r;
    if (owner[rr][c]) [rr, c] = owner[rr][c];
    grid[rr][c] = grid[rr][c] ? grid[rr][c] + ' ' + word.text : word.text;
    conf[rr][c] = Math.min(conf[rr][c], Number.isFinite(word.score) ? word.score : 1);
  }

  const rowEmpty = (r) => grid[r].every((t) => !t);
  const colEmpty = (c) => grid.every((row) => !row[c]);
  while (grid.length > 1 && rowEmpty(0)) { grid.shift(); conf.shift(); boxes.shift(); spans.shift(); }
  while (grid.length > 1 && rowEmpty(grid.length - 1)) { grid.pop(); conf.pop(); boxes.pop(); spans.pop(); }
  let keepCols = ncol;
  while (keepCols > 1 && colEmpty(keepCols - 1)) {
    grid.forEach((r) => r.pop()); conf.forEach((r) => r.pop());
    boxes.forEach((r) => r.pop()); spans.forEach((r) => r.pop());
    keepCols--;
  }
  return { grid, conf, boxes, spans, cells: grid.length * keepCols, rows: grid.length, cols: keepCols };
}

async function structureTable(canvas, words) {
  const tatr = await tatrTable(canvas, words);
  if (tatr) return tatr;
  const sess = await getStructureSession();
  if (!sess) return null;
  postStatus('沒有明顯格線，改用表格結構模型…');
  const out = await sess.run({ x: structureInput(canvas) });
  const tensors = Object.values(out);
  const loc = tensors.find((t) => t.dims.length === 3 && t.dims[2] === 8);
  const probs = tensors.find((t) => t.dims.length === 3 && t.dims[2] === TABLE_VOCAB.length);
  if (!loc || !probs) return null;
  const rows = structureRows(loc, probs, canvas.width, canvas.height);
  return rowsToTable(rows, words);
}

/* =============================================================
   訊息處理
   ============================================================= */
let msgQueue = Promise.resolve();
self.onmessage = (event) => {
  msgQueue = msgQueue.then(() => handleMessage(event)).catch(() => {});
};

async function handleMessage(event) {
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
    if (msg.type === 'grid') {
      // PDF 文字層用：字已經有了，只要格線。不載 OCR 模型，只裁出 box 範圍找線
      // （detectLines 要求線貫穿大半張圖，所以要先裁到表格附近）
      const bitmap = await decodeImage(msg.buffer);
      let grid = null;
      try {
        const { x, y, w, h } = msg.box;
        const c = new OffscreenCanvas(w, h);
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
        const rgba = g.getImageData(0, 0, w, h).data;
        const gray = new Uint8Array(w * h);
        for (let i = 0; i < gray.length; i++) {
          gray[i] = rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114;
        }
        const lineGray = normalizeForLines(gray, w, h);
        grid = { v: detectLines(lineGray, w, h, true), h: detectLines(lineGray, w, h, false) };
      } finally { bitmap.close(); }
      self.postMessage({ type: 'grid-result', id, grid });
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
      .filter((r) => {
        const t = r.text.trim();
        if (!t) return false;
        const minConf = /^[-.,\d０-９－．]+$/.test(t) ? MIN_NUMERIC_CONFIDENCE : MIN_CONFIDENCE;
        return r.confidence >= minConf;
      })
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
    // 內部格線太少＝沒有欄界可用 → 交給表格結構模型決定格子（用已映射好的字框）
    let structure = null;
    const weakGrid = (grid?.v?.length || 0) < 3 || (grid?.h?.length || 0) < 3;
    if (weakGrid) {
      try { structure = await structureTable(canvas, results); } catch (err) { self.__structErr = String(err?.message || err); }
    }
    self.postMessage({ type: 'result', id, confidence, results, grid, structure, structErr: self.__structErr || null, preview, previewScale,
      normalized: ocrNormalized, backend: { ocr: serviceBackend, layout: layoutBackend() } });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err?.message || err) });
  }
};
