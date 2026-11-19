/* PP-OCRv6 背景處理 Worker：表格偵測 + 透視矯正 + OCR。
 *
 * 為什麼用 jsDelivr 的 +esm：ppu-paddle-ocr 的 web 版以 bare specifier 匯入
 * onnxruntime-web，Worker 沒有頁面的 import map，+esm 會先把依賴改寫成
 * CDN 絕對路徑。辨識直接吃 OffscreenCanvas，不再需要 PNG 來回。
 */
import {
  PaddleOcrService,
  getDefaultWebExecutionProviders,
} from 'https://cdn.jsdelivr.net/npm/ppu-paddle-ocr@6.7.0/web/+esm';
// 與 ppu 內部使用同一個 onnxruntime-web 模組（同版本、同 URL），避免載入兩份 runtime
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/+esm';

// 多執行緒 WASM 需要 crossOriginIsolated（COOP/COEP）；沒有就只能單執行緒。
// 要在第一個 session 建立前設定，之後改不了
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

// OCR 模型放在自己網域（models/，取自 HF snowfluke/ppu-paddle-ocr-models）：
// 有些 Android 手機用 fetch 跨網域抓 HF 會 Failed to fetch（網址列直接下載卻正常）
const M = new URL('models/', self.location.href).href;
const local = (size, dict = 'ppocrv6_dict.txt') => ({
  detection: `${M}PP-OCRv6_${size}_det.ort`,
  recognition: `${M}PP-OCRv6_${size}_rec.ort`,
  charactersDictionary: `${M}${dict}`,
});
const QUALITY = {
  tiny: { label: '快速', size: '6MB', model: local('tiny', 'ppocrv6_tiny_dict.txt') },
  small: { label: '標準', size: '30MB', model: local('small') },
};
const MIN_CONFIDENCE = 0.3;
const MIN_NUMERIC_CONFIDENCE = 0.2;
// 轉正後畫布的最長邊：ppu-paddle-ocr 辨識裁切來源上限即為 2000px，設 1920 可避免
// 內部多拷貝縮放一次（ratio === 1），使文字偵測與前處理快約 42%，且 6 張實測
// 格級 97.4%、數字格 99.4%（較 2560px 的 95.0% / 98.8% 更準）；3200px 反而把字切碎且慢一倍。
const RECT_MAX_SIDE = 1920;
const FULL_QUAD = [[0, 0], [1, 0], [1, 1], [0, 1]];

const LAYOUT_MODEL = 'models/pp_doclayout_s.onnx';   // 取自 HF stefanj0/PP-DocLayout-S-ONNX@7e851b9
const TABLE_CLASS = 8, FALLBACK_CLASSES = [1, 18], TABLE_MIN_SCORE = 0.5;

let service = null, serviceQuality = null, serviceBackend = null, toTraditional = null;
let layoutSession = null;

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
  // 全形數字、O→0、l→1 這類修正交給主畫面的 repairNumericCells：那邊會記下原辨識，
  // 格子上才看得到「已自動整理：原辨識…」。在這裡先改掉，使用者就無從核對
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
  const svc = new PaddleOcrService({ model: info.model });
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
  return layoutSession ? 'wasm' : null;
}

async function getLayoutSession() {
  if (layoutSession) return layoutSession;
  if (!ort.env.wasm.wasmPaths) {
    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
  }
  ort.env.wasm.proxy = false;
  layoutSession = await ort.InferenceSession.create(LAYOUT_MODEL, {
    executionProviders: ['wasm'],
    logSeverityLevel: 3,
  });
  return layoutSession;
}

async function runLayout(makeInputs) {
  const session = await getLayoutSession();
  return await session.run(makeInputs());
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
  const plane = N * N;
  const data = new Float32Array(3 * plane);
  const m0 = 0.485, m1 = 0.456, m2 = 0.406;
  const s0 = 0.229, s1 = 0.224, s2 = 0.225;
  for (let i = 0; i < plane; i++) {
    const p = i * 4;
    data[i] = (px[p] / 255 - m0) / s0;
    data[plane + i] = (px[p + 1] / 255 - m1) / s1;
    data[2 * plane + i] = (px[p + 2] / 255 - m2) / s2;
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
  // ponytail: 外擴 1% 是試出來的。f-tilted 的歪斜表頭剛好落在框外（少一列），
  // 但改成 2% 時 b-photo、e-balance-photo 反而各掉 4～7 個百分點（六張合計 數字 98.2→96.3%）。
  // 六張樣本太少，別再憑這幾張調；有更多實拍樣本再一起量
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
  if (!(w > 0 && h > 0)) return null;
  const dst = [[0, 0], [w, 0], [w, h], [0, h]], A = [];
  dst.forEach(([u, v], k) => {
    const [x, y] = src[k];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x], [0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  });
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const m = A.map((row, i) => row[8] / row[i]);
  if (!m.every(Number.isFinite)) return null;
  const det =
    m[0] * (m[4] - m[5] * m[7]) -
    m[1] * (m[3] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  return m;
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
  // ponytail: 對比度、中值去噪都量過，不加（2026-11-15，6 張圖，格級／數字格）：
  //   現行 95.0/97.6；中值 3×3 → 94.2/94.5（逗號、小數點被抹掉，a、b 掉最多）；
  //   對比 1.2× → 93.7/97.6（e-balance-photo 90→98.3，但 a、b、c 各掉 3~5 格；
  //   b 也是實拍，所以「只對照片套」也救不了）；兩者並用 → 94.5/97.0。
  //   等有更多真實手機照再重測對比度。
  // 輕微 3×3 Unsharp Mask 銳化筆畫邊緣（用 3 列滾動緩衝區避免複製整張圖）
  if (w < 3 || h < 3) return;
  const a = 0.12; // 銳化強度 (4*a = 0.48)
  const cWeight = 1 + 4 * a;
  const stride = w * 4;
  let prevRow = new Uint8ClampedArray(data.subarray(0, stride));
  let curRow = new Uint8ClampedArray(data.subarray(stride, stride * 2));
  let nextRow = new Uint8ClampedArray(stride);
  for (let y = 1; y < h - 1; y++) {
    const rowOff = y * stride;
    nextRow.set(data.subarray(rowOff + stride, rowOff + stride * 2));
    for (let x = 1; x < w - 1; x++) {
      const p = x * 4;
      const o = rowOff + p;
      for (let ch = 0; ch < 3; ch++) {
        const v = curRow[p + ch] * cWeight
          - (curRow[p - 4 + ch] + curRow[p + 4 + ch] + prevRow[p + ch] + nextRow[p + ch]) * a;
        data[o + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    const tmp = prevRow;
    prevRow = curRow;
    curRow = nextRow;
    nextRow = tmp;
  }
}

function rectifiedCanvas(bitmap, quad, opts = {}) {
  const q = Array.isArray(quad) && quad.length === 4 ? quad : FULL_QUAD;
  const nq = orderPoints(q.map(([x, y]) => [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]));
  const isRect = Math.abs(nq[0][0] - nq[3][0]) < 1e-4 && Math.abs(nq[1][0] - nq[2][0]) < 1e-4
    && Math.abs(nq[0][1] - nq[1][1]) < 1e-4 && Math.abs(nq[3][1] - nq[2][1]) < 1e-4;

  let out, og, id, d, dw, dh;
  if (isRect) {
    const sx = nq[0][0] * bitmap.width;
    const sy = nq[0][1] * bitmap.height;
    const sw = Math.max(1, (nq[1][0] - nq[0][0]) * bitmap.width);
    const sh = Math.max(1, (nq[3][1] - nq[0][1]) * bitmap.height);
    const s0 = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
    const scale = Math.min(3, RECT_MAX_SIDE / Math.max(sw * s0, sh * s0));
    dw = Math.max(2, Math.round(sw * s0 * scale));
    dh = Math.max(2, Math.round(sh * s0 * scale));
    out = new OffscreenCanvas(dw, dh);
    og = out.getContext('2d', { willReadFrequently: true });
    og.imageSmoothingEnabled = true;
    og.imageSmoothingQuality = 'high';
    og.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh);
    id = og.getImageData(0, 0, dw, dh);
    d = id.data;
  } else {
    const s0 = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
    const W = Math.max(2, Math.round(bitmap.width * s0)), H = Math.max(2, Math.round(bitmap.height * s0));
    const pts = nq.map(([x, y]) => [x * (W - 1), y * (H - 1)]);
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const w0 = Math.max(dist(pts[0], pts[1]), dist(pts[3], pts[2]), 1);
    const h0 = Math.max(dist(pts[0], pts[3]), dist(pts[1], pts[2]), 1);
    const scale = Math.min(3, RECT_MAX_SIDE / Math.max(w0, h0));
    dw = Math.max(2, Math.round(w0 * scale));
    dh = Math.max(2, Math.round(h0 * scale));
    out = new OffscreenCanvas(dw, dh);
    og = out.getContext('2d', { willReadFrequently: true });
    const m = homography(dw - 1, dh - 1, pts);
    if (!m) {
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const bx = Math.min(...xs) / s0, by = Math.min(...ys) / s0;
      const bw = Math.max(1, (Math.max(...xs) - Math.min(...xs)) / s0);
      const bh = Math.max(1, (Math.max(...ys) - Math.min(...ys)) / s0);
      og.imageSmoothingEnabled = true;
      og.imageSmoothingQuality = 'high';
      og.drawImage(bitmap, bx, by, bw, bh, 0, 0, dw, dh);
      id = og.getImageData(0, 0, dw, dh);
      d = id.data;
    } else {
      const src = new OffscreenCanvas(W, H);
      const sg = src.getContext('2d', { willReadFrequently: true });
      sg.drawImage(bitmap, 0, 0, W, H);
      const rgba = sg.getImageData(0, 0, W, H).data;
      id = og.createImageData(dw, dh);
      d = id.data;
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
    }
  }
  // 量測（2026-11-15，標準模型，bench 六張）：拿掉這一步 格 95.5→94.5%、數字 98.2→95.1%，所以保留
  normalizeAndSharpen(d, dw, dh);
  const outGray = opts.needGray === false ? null : new Uint8Array(dw * dh);   // 給格線偵測用
  if (outGray) {
    for (let i = 0, o = 0; i < outGray.length; i++, o += 4) {
      outGray[i] = d[o] * 0.299 + d[o + 1] * 0.587 + d[o + 2] * 0.114;
    }
  }
  og.putImageData(id, 0, 0);
  return { canvas: out, gray: outGray, width: dw, height: dh };
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

// 大圖先做 2×2 min-pool 降採樣（保留 1px 細暗線），讓找線像素減為 1/4 再還原座標
function detectGridLines(gray, width, height) {
  if (Math.max(width, height) > 1400) {
    const w2 = width >> 1, h2 = height >> 1;
    const g2 = new Uint8Array(w2 * h2);
    for (let y = 0; y < h2; y++) {
      const r0 = (y * 2) * width, r1 = r0 + width;
      const dst = y * w2;
      for (let x = 0; x < w2; x++) {
        const x2 = x * 2;
        const a = gray[r0 + x2], b = gray[r0 + x2 + 1], c = gray[r1 + x2], d = gray[r1 + x2 + 1];
        const m1 = a < b ? a : b, m2 = c < d ? c : d;
        g2[dst + x] = m1 < m2 ? m1 : m2;
      }
    }
    const lg = normalizeForLines(g2, w2, h2);
    const mapLine = (l) => ({ a: l.a * 2 + 0.5 * (1 - l.b), b: l.b });
    return {
      v: detectLines(lg, w2, h2, true).map(mapLine),
      h: detectLines(lg, w2, h2, false).map(mapLine),
    };
  }
  const lg = normalizeForLines(gray, width, height);
  return {
    v: detectLines(lg, width, height, true),
    h: detectLines(lg, width, height, false),
  };
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

// 批次只重跑 recognitor（跳過 DBNet 重偵測）；若無 recognitor 介面或發生例外再退回逐格 recCrop
async function recognizeBoxes(svc, canvas, boxes) {
  const out = new Array(boxes.length).fill(null);
  if (!boxes.length) return out;
  const validBoxes = [];
  const validIndices = [];
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (!b) continue;
    const x = Math.max(0, Math.floor(b.x));
    const y = Math.max(0, Math.floor(b.y));
    const x2 = Math.min(canvas.width, Math.ceil(b.x + b.width));
    const y2 = Math.min(canvas.height, Math.ceil(b.y + b.height));
    const width = x2 - x, height = y2 - y;
    if (width >= 2 && height >= 2) {
      validBoxes.push({ x, y, width, height });
      validIndices.push(i);
    }
  }
  if (!validBoxes.length) return out;

  if (typeof svc?.recognitor?.run === 'function') {
    try {
      const dict = svc.options?.recognition?.charactersDictionary;
      const batchRes = await svc.recognitor.run(canvas, validBoxes, dict, 'per-box', { minimumConfidence: 0 });
      if (Array.isArray(batchRes) && batchRes.length === validBoxes.length) {
        for (let bi = 0; bi < validBoxes.length; bi++) out[validIndices[bi]] = batchRes[bi];
        return out;
      }
      if (Array.isArray(batchRes)) {
        for (let bi = 0; bi < validBoxes.length; bi++) {
          const vb = validBoxes[bi];
          const vcx = vb.x + vb.width / 2, vcy = vb.y + vb.height / 2;
          const maxDist = Math.max(vb.width, vb.height);
          let bestItem = null, bestDist = Infinity;
          for (const item of batchRes) {
            const ib = item?.box;
            if (!ib) continue;
            const d = Math.hypot((ib.x + ib.width / 2) - vcx, (ib.y + ib.height / 2) - vcy);
            if (d <= maxDist && d < bestDist) { bestDist = d; bestItem = item; }
          }
          out[validIndices[bi]] = bestItem;
        }
        return out;
      }
    } catch (err) { /* 失敗退回逐格 recCrop */ }
  }

  for (let bi = 0; bi < validBoxes.length; bi++) {
    const b = validBoxes[bi];
    try {
      out[validIndices[bi]] = await recCrop(svc, canvas, b.x, b.y, b.x + b.width, b.y + b.height);
    } catch (err) { /* 忽略單框失敗 */ }
  }
  return out;
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

/* 信心偏低的字框，一次批次重辨識（預算 12 次，免重跑文字偵測）。
 * 只處理「原本就認得、但信心很低」的框；補救切出來的碎片不再重跑（它們已經重辨識過）。 */
async function reOcrWeakWords(canvas, results, svc) {
  const out = results.slice();
  const weakIdx = [];
  const weakBoxes = [];
  for (let i = 0; i < results.length && weakIdx.length < 12; i++) {
    const r = results[i];
    // 只救「短片段」（單一個字／單一數字最容易讀錯，例如 1→人、1→二）；
    // 長字串重跑的風險是「主持人費3」這種多出一個字的結果，得不償失（實測）
    if (r.confidence < 0.6 && r.text.trim().length <= 3 && !r.rescued) {
      const pad = Math.max(2, r.box.height * 0.12);
      weakIdx.push(i);
      weakBoxes.push({ x: r.box.x - pad, y: r.box.y - pad, width: r.box.width + pad * 2, height: r.box.height + pad * 2 });
    }
  }
  if (!weakIdx.length) return out;
  try {
    const batchRes = await recognizeBoxes(svc, canvas, weakBoxes);
    for (let bi = 0; bi < weakIdx.length; bi++) {
      const wi = weakIdx[bi];
      const r = out[wi], hit = batchRes[bi];
      // 只有「明顯更有把握、而且不是空白」才換掉原本的字
      if (hit?.text?.trim() && hit.confidence > r.confidence + 0.15 && hit.text.trim().length <= 3) {
        out[wi] = { ...r, text: hit.text, confidence: hit.confidence, reOcr: true };
      }
    }
  } catch (err) { /* 失敗就保留原結果 */ }
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
  const out = new Array(results.length);
  const pending = [];
  let budget = 24;   // 每次辨識最多補 24 次，避免大表格把時間吃掉
  const hasHLines = Boolean(grid?.h?.length);
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
    const tableTop = hasHLines ? Math.min(...grid.h.map((l) => l.a + l.b * (r.box.x + r.box.width / 2))) : -Infinity;
    if (cy < tableTop || !cuts.length || r.text.trim().length < 2 || isNumeric(r.text) || budget <= 0) {
      out[i] = [r];
      continue;
    }

    const x = cuts[0];
    // 「項次＋科目」被框成一個字時，文字本身就會說話：「1人事費」＝代號 1 ／ 科目 人事費。
    // 這種前綴代號（數字、字母、1-1 形式）後面接中文的，直接依文繞切，比依框寬比例準：
    // 偵測框的 padding 讓框的左緣離文字很遠，按比例切常常把「1」跟「人」切在一起。
    const codeSplit = r.text.match(/^([0-9０-９A-Za-z][0-9０-９A-Za-z\-./]{0,3})\s*([\u4e00-\u9fff][\s\S]*)$/);
    // 再確認一次「線的位置」與「代號該佔的寬度」不要差太遠，避免把「2024年報」這種切開
    const codeUnits = codeSplit ? [...codeSplit[1]].reduce((n, ch) => n + charUnits(ch), 0) : 0;
    const totalUnits = [...r.text].reduce((n, ch) => n + charUnits(ch), 0);
    const codeFrac = codeSplit ? codeUnits / Math.max(1, totalUnits) : 0;
    const fracNow = (x - r.box.x) / Math.max(1, r.box.width);
    // 代號本身就是數字（「1人事費」的 1、項次欄的 2），所以不能沿用「整格是數字就不拆」那條
    if (codeSplit && Math.abs(fracNow - codeFrac) < 0.45) {
      out[i] = [
        { ...r, text: codeSplit[1], rescued: true, box: { ...r.box, width: x - r.box.x } },
        { ...r, text: codeSplit[2], rescued: true, box: { ...r.box, x, width: r.box.x + r.box.width - x } },
      ];
      continue;
    }
    // 先用字寬比例快速切一次：像「1-1主 → 1-1 ／ 主」這種看得出來的，
    // 就不必再花時間跑兩次辨識（乾淨掃描件大多是這種）
    const frac = (x - r.box.x) / Math.max(1, r.box.width);
    const cheap = geometricSplit(r.text, frac);
    if (cheap && /^[\dA-Za-z\-.,()\/]+$/.test(cheap[0]) && cheap[0].length <= 6) {
      out[i] = [
        { ...r, text: cheap[0], rescued: true, box: { ...r.box, width: x - r.box.x } },
        { ...r, text: cheap[1], rescued: true, box: { ...r.box, x, width: r.box.x + r.box.width - x } },
      ];
      continue;
    }
    // 這裡刻意「每一框都補救」，不依「這一列字框數夠不夠」省略：
    // 會跨線的框本來就是該補救的那幾個，省掉它換到的是整表錯位的代價。
    const pad = r.box.height * 0.25;
    const y1 = r.box.y - pad, y2 = r.box.y + r.box.height + pad;
    // 用格線（而不是偵測框的邊）決定裁切範圍：偵測框的 padding 會把隔壁的字含進來，
    // 單邊裁切就會多認出一個字（「1」被讀成「1人」）
    let leftEdge = r.box.x - 2, rightBound = r.box.x + r.box.width + 2;
    for (const l of vLines) {
      const vx = l.a + l.b * cy;
      if (vx < x - 2 && vx > leftEdge) leftEdge = vx;
      if (vx > x + 2 && vx < rightBound) rightBound = vx;
    }
    budget -= 2;
    out[i] = [r];
    pending.push({
      i, r, x,
      lBox: { x: leftEdge, y: y1, width: Math.max(0, x - 2 - leftEdge), height: Math.max(0, y2 - y1) },
      rBox: { x: x + 2, y: y1, width: Math.max(0, rightBound - (x + 2)), height: Math.max(0, y2 - y1) },
    });
  }

  if (pending.length) {
    let batchRes = [];
    try {
      batchRes = await recognizeBoxes(svc, canvas, pending.flatMap((p) => [p.lBox, p.rBox]));
    } catch (err) { batchRes = []; }
    for (let pi = 0; pi < pending.length; pi++) {
      const { i, r, x } = pending[pi];
      const left = batchRes[pi * 2], right = batchRes[pi * 2 + 1];
      // 單一個字的裁切常常辨識不出來（「主」「業」）：只要一邊認得、又是原字串的
      // 開頭/結尾，另一邊就用剩下的字補齊。兩邊拼不回來原字串就整筆放棄。
      const whole = squash(r.text);
      let L = left?.text ? squash(left.text) : null;
      let R = right?.text ? squash(right.text) : null;
      if (L && !R && whole.startsWith(L)) R = whole.slice(L.length) || null;
      else if (!L && R && whole.endsWith(R)) L = whole.slice(0, whole.length - R.length) || null;
      if (!L || !R || L + R !== whole) continue;
      // 拆出單一個中文字、右邊又接著中文：這是同一個詞被雜線切開（陰影、紙緣），不是兩格
      if (L.length === 1 && CJK_G.test(L) && CJK_G.test(R[0])) continue;

      out[i] = [
        { ...r, text: left?.text || L, confidence: left?.confidence ?? r.confidence, rescued: true,
          box: { ...r.box, width: x - r.box.x } },
        { ...r, text: right?.text || R, confidence: right?.confidence ?? r.confidence, rescued: true,
          box: { ...r.box, x, width: r.box.x + r.box.width - x } },
      ];
    }
  }
  return out.flat();
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
  const owner = Array.from({ length: nrow }, () => new Array(ncol).fill(null));
  for (const cell of cells) {
    spans[cell.r][cell.c] = { rs: cell.rowspan, cs: cell.colspan };
    boxes[cell.r][cell.c] = { x1: cell.x1, y1: cell.y1, x2: cell.x2, y2: cell.y2 };
    for (let dr = 0; dr < cell.rowspan; dr++) {
      for (let dc = 0; dc < cell.colspan; dc++) owner[cell.r + dr][cell.c + dc] = [cell.r, cell.c];
    }
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
  // 去掉頭尾整列／整欄空白（保留跨欄／跨列合併格，不截斷 rowspan/colspan）
  const rowEmpty = (r) => grid[r].every((t) => !t)
    && spans[r].every((sp, c) => !owner[r][c] || (sp && sp.rs === 1));
  const colEmpty = (c) => grid.every((row) => !row[c])
    && spans.every((row, r) => !owner[r][c] || (row[c] && row[c].cs === 1));
  while (grid.length > 1 && rowEmpty(0)) { grid.shift(); conf.shift(); boxes.shift(); spans.shift(); owner.shift(); }
  while (grid.length > 1 && rowEmpty(grid.length - 1)) { grid.pop(); conf.pop(); boxes.pop(); spans.pop(); owner.pop(); }
  while (ncol > 1 && colEmpty(ncol - 1)) {
    grid.forEach((r) => r.pop()); conf.forEach((r) => r.pop());
    boxes.forEach((r) => r.pop()); spans.forEach((r) => r.pop()); owner.forEach((r) => r.pop());
    ncol--;
  }
  return { grid, conf, boxes, spans, cells: cells.length, rows: grid.length, cols: ncol };
}

async function slanetTable(canvas, words) {
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

// 無內部格線時改用 SLANet 表格結構模型定位格子（失敗就退回格線／空白切欄）
async function structureTable(canvas, words) {
  try {
    return await slanetTable(canvas, words);
  } catch (err) {
    return null;
  }
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
    if (msg.type === 'warmup') {
      await getLayoutSession().catch(() => null);
      await ensureService(msg.quality).catch(() => null);
      self.postMessage({ type: 'warmup-result', id, backend: { ocr: serviceBackend, layout: layoutBackend() } });
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
        grid = detectGridLines(gray, w, h);
      } finally { bitmap.close(); }
      self.postMessage({ type: 'grid-result', id, grid });
      return;
    }
    if (msg.type !== 'ocr') return;

    const svc = await ensureService(msg.quality);
    postStatus('辨識中，請稍候…');
    const bitmap = await decodeImage(msg.buffer);
    let canvas, grid = null, rectRef = null;
    try {
      const rect = rectifiedCanvas(bitmap, msg.quad, { needGray: !msg.textOnly });
      rectRef = rect;          // rect 原本是 try 區塊內的 const，外面拿不到（縮圖要用）
      canvas = rect.canvas;
      if (!msg.textOnly && rect.gray) {
        try {
          grid = detectGridLines(rect.gray, rect.width, rect.height);
        } catch (err) { /* 格線只是輔助，失敗就照舊用空白切欄 */ }
      }
    } finally { bitmap.close(); }
    // per-box：逐框辨識。預設逐行合併遇到歪斜 2° 以上的照片會整張讀成亂碼
    const res = await svc.recognize(canvas, {
      flatten: true,
      minimumConfidence: 0,
      strategy: 'per-box',
    });
    // 跨格線的字框先切開重辨識，後面的切欄才不會從這裡歪掉（文字模式不需要切欄）
    let words = res.results;
    if (!msg.textOnly) {
      try { words = await splitStraddling(canvas, res.results, grid, svc); } catch (err) { /* 補救失敗就用原結果 */ }
    }
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
    // 轉正後的縮圖（Blob）：表格模式才需要，文字模式不畫原圖對照故跳過編碼
    let preview = null, previewScale = 1;
    if (!msg.textOnly) {
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
    }
    // 內部格線太少＝沒有欄界可用 → 交給表格結構模型決定格子（用已映射好的字框）
    let structure = null, structErr = null;
    const weakGrid = (grid?.v?.length || 0) < 3 || (grid?.h?.length || 0) < 3;
    if (weakGrid && !msg.textOnly) {   // 文字模式不需要格子
      try { structure = await structureTable(canvas, results); } catch (err) { structErr = String(err?.message || err); }
    }
    self.postMessage({ type: 'result', id, confidence, results, grid, structure, structErr, preview, previewScale,
      backend: { ocr: serviceBackend, layout: layoutBackend() } });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err?.message || err) });
  }
};
