/* ocr-worker.js 純影像/幾何工具函式單元測試（不載入模型／不依賴瀏覽器）。
 * 執行：node tests/test_worker_utils.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "pic-calculator", "static", "ocr-worker.js"), "utf8");

const extract = (name) => src.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`))[0];
const code = [
  "const CJK_G = /[\\u4e00-\\u9fff]/;",
  extract("homography"),
  extract("estimatePaperBackground"),
  extract("normalizeAndSharpen"),
  extract("normalizeForLines"),
  extract("detectLines"),
  extract("detectGridLines"),
  extract("recognizeBoxes"),
  extract("charUnits"),
  extract("geometricSplit"),
  extract("splitStraddling"),
  "return { homography, normalizeAndSharpen, detectGridLines, recognizeBoxes, charUnits, splitStraddling };",
].join("\n");

let recCropCalls = 0;
const { homography, normalizeAndSharpen, detectGridLines, recognizeBoxes, splitStraddling } = new Function("recCrop", code)(
  async (_svc, _canvas, x1, _y1, x2) => {
    recCropCalls++;
    return { text: `fallback@${Math.round(x1)}-${Math.round(x2)}`, confidence: 0.91 };
  }
);

// 1) homography：正常矩形回傳 8 係數；退化矩形／共線／零寬高回 null
const hOk = homography(100, 200, [[10, 20], [110, 20], [110, 220], [10, 220]]);
assert.ok(Array.isArray(hOk) && hOk.length === 8);
assert.ok(Math.abs(hOk[2] - 10) < 1e-6 && Math.abs(hOk[5] - 20) < 1e-6);

assert.strictEqual(homography(0, 100, [[0, 0], [10, 0], [10, 10], [0, 10]]), null, "零寬度應回 null");
assert.strictEqual(homography(100, 100, [[0, 0], [0, 0], [10, 10], [0, 10]]), null, "重複角點應回 null");
assert.strictEqual(homography(100, 100, [[0, 0], [50, 0], [100, 0], [20, 0]]), null, "四點共線應回 null");

// 2) normalizeAndSharpen：滾動 3 列緩衝區應與全圖複製 3×3 Unsharp Mask 完全一致
const W = 40, H = 30;
const imgA = new Uint8ClampedArray(W * H * 4);
const imgB = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    const base = 180 + ((x * 7 + y * 13) % 50) - (x === 20 || y === 15 ? 80 : 0);
    imgA[o] = imgB[o] = Math.max(0, Math.min(255, base));
    imgA[o + 1] = imgB[o + 1] = Math.max(0, Math.min(255, base - 5));
    imgA[o + 2] = imgB[o + 2] = Math.max(0, Math.min(255, base + 5));
    imgA[o + 3] = imgB[o + 3] = 255;
  }
}
// 參考實作（先跑同一個 bg 正規化後，用完整 copy 做 3×3 unsharp mask）
const { estimatePaperBackground } = new Function(extract("estimatePaperBackground") + "\nreturn { estimatePaperBackground };")();
const { bg, sw, sh, ds } = estimatePaperBackground(imgB, W, H);
for (let y = 0; y < H; y++) {
  const sy = Math.min(sh - 1, (y / ds) | 0);
  for (let x = 0; x < W; x++) {
    const sx = Math.min(sw - 1, (x / ds) | 0);
    const bgVal = bg[sy * sw + sx];
    if (bgVal <= 40) continue;
    const gain = Math.min(2.2, 238 / bgVal);
    const o = (y * W + x) * 4;
    imgB[o] = Math.min(255, imgB[o] * gain);
    imgB[o + 1] = Math.min(255, imgB[o + 1] * gain);
    imgB[o + 2] = Math.min(255, imgB[o + 2] * gain);
  }
}
const copyRef = new Uint8ClampedArray(imgB);
const a = 0.12, cWeight = 1 + 4 * a, stride = W * 4;
for (let y = 1; y < H - 1; y++) {
  for (let x = 1; x < W - 1; x++) {
    const o = y * stride + x * 4;
    for (let ch = 0; ch < 3; ch++) {
      const v = copyRef[o + ch] * cWeight
        - (copyRef[o - 4 + ch] + copyRef[o + 4 + ch] + copyRef[o - stride + ch] + copyRef[o + stride + ch]) * a;
      imgB[o + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
}
normalizeAndSharpen(imgA, W, H);
assert.deepStrictEqual(imgA, imgB, "滾動緩衝區銳化輸出必須與全圖複製完全一致");

// 3) splitStraddling：多字元前綴（"1-1"）應使用完整字元寬度而非只算首字
assert.ok(/\[\.\.\.codeSplit\[1\]\]\.reduce/.test(src), "codeFrac 應加總 codeSplit[1] 全部字元寬度");
(async () => {
  const res = await splitStraddling(
    { width: 500, height: 200 },
    [{ text: "1-1主持人費", confidence: 0.95, box: { x: 20, y: 100, width: 160, height: 24 } }],
    { v: [{ a: 75, b: 0 }], h: [{ a: 80, b: 0 }] },
    {}
  );
  assert.strictEqual(res.length, 2);
  assert.strictEqual(res[0].text, "1-1");
  assert.strictEqual(res[1].text, "主持人費");

  // 4) detectGridLines：大圖（1600×1600）2×2 min-pool 仍可抓到 1px 細暗線並還原座標（±2px）
  const gw = 1600, gh = 1600;
  const gGray = new Uint8Array(gw * gh).fill(230);
  for (let y = 0; y < gh; y++) gGray[y * gw + 400] = 40;
  for (let x = 0; x < gw; x++) gGray[800 * gw + x] = 40;
  const grid = detectGridLines(gGray, gw, gh);
  assert.strictEqual(grid.v.length, 1, "1600×1600 應偵測到 1 條垂直線");
  assert.strictEqual(grid.h.length, 1, "1600×1600 應偵測到 1 條水平線");
  assert.ok(Math.abs(grid.v[0].a - 400) <= 2, `垂直線座標應在 400±2 內，實際 ${grid.v[0].a}`);
  assert.ok(Math.abs(grid.h[0].a - 800) <= 2, `水平線座標應在 800±2 內，實際 ${grid.h[0].a}`);

  // 5) recognizeBoxes：優先走 recognitor.run 單次批次，缺失或長度不等時也能正確對位／回退 recCrop
  let batchCalls = 0;
  const mockSvc = {
    options: { recognition: { charactersDictionary: ["a", "b"] } },
    recognitor: {
      async run(_canvas, boxes) {
        batchCalls++;
        return boxes.map((b, i) => ({ text: `b${i}@${b.x}`, confidence: 0.95, box: b }));
      },
    },
  };
  const batchOut = await recognizeBoxes(mockSvc, { width: 500, height: 200 }, [
    { x: 10, y: 20, width: 40, height: 20 },
    { x: 0, y: 0, width: 0, height: 10 },
    { x: 100, y: 20, width: 60, height: 20 },
  ]);
  assert.strictEqual(batchCalls, 1, "應只呼叫 1 次 recognitor.run");
  assert.strictEqual(batchOut[0].text, "b0@10");
  assert.strictEqual(batchOut[1], null);
  assert.strictEqual(batchOut[2].text, "b1@100");

  // 長度不等時以中心距離匹配
  const partialSvc = {
    options: { recognition: {} },
    recognitor: {
      async run(_canvas, boxes) {
        return [{ text: "second", confidence: 0.9, box: boxes[1] }];
      },
    },
  };
  const partialOut = await recognizeBoxes(partialSvc, { width: 500, height: 200 }, [
    { x: 10, y: 20, width: 40, height: 20 },
    { x: 200, y: 20, width: 40, height: 20 },
  ]);
  assert.strictEqual(partialOut[0], null);
  assert.strictEqual(partialOut[1].text, "second");

  // 沒有 recognitor 時回退 recCrop
  recCropCalls = 0;
  const fbOut = await recognizeBoxes({}, { width: 500, height: 200 }, [
    { x: 12, y: 20, width: 30, height: 20 },
  ]);
  assert.strictEqual(recCropCalls, 1);
  assert.strictEqual(fbOut[0].text, "fallback@12-42");

  console.log("PASS  worker 幾何與影像處理工具函式");
})().catch((err) => { console.error(err); process.exit(1); });
