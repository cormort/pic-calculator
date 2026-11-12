/* 格線偵測（ocr-worker.js）的合成影像測試：低對比、半邊陰影的照片也要抓得到格線。
 * 執行：node tests/test_lines.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "pic-calculator", "static", "ocr-worker.js"), "utf8");
const fns = ["detectLines", "normalizeForLines"]
  .map((fn) => src.match(new RegExp(`function ${fn}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0]).join("\n");
const { detectLines, normalizeForLines } = new Function(fns + "\nreturn { detectLines, normalizeForLines };")();

const W = 800, H = 600;
const V = [100, 300, 500, 700], HZ = [100, 200, 300, 400, 500];
// paperAt(x)／lineAt(x)：該位置紙張與格線的灰階；格子裡放一些短筆畫當成文字
function makeImage(paperAt, lineAt) {
  const g = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = paperAt(x);
  for (const x0 of V) for (let y = 80; y < 520; y++) for (let x = x0; x < x0 + 2; x++) g[y * W + x] = lineAt(x);
  for (const y0 of HZ) for (let x = 80; x < 720; x++) for (let y = y0; y < y0 + 2; y++) g[y * W + x] = lineAt(x);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 400; k++) {   // 文字：2px 寬、14px 高的筆畫
    const x0 = 110 + Math.floor(rnd() * 580), y0 = 110 + Math.floor(rnd() * 380);
    if (V.some((v) => Math.abs(v - x0) < 8) || HZ.some((h) => Math.abs(h - y0) < 18)) continue;
    for (let y = y0; y < y0 + 14; y++) for (let x = x0; x < x0 + 2; x++) g[y * W + x] = lineAt(x) - 20;
  }
  return g;
}
const count = (g) => [detectLines(g, W, H, true).length, detectLines(g, W, H, false).length];
const lines = (g) => count(normalizeForLines(g, W, H));

// 1. 一般清楚的圖：校正前後都抓到全部格線（不能變差）
const clean = makeImage(() => 230, () => 120);
assert.deepStrictEqual(count(clean), [4, 5]);
assert.deepStrictEqual(lines(clean), [4, 5]);

// 2. 昏暗、低對比：線只比紙暗 14 階，原本一條都抓不到
const dim = makeImage(() => 120, () => 106);
assert.deepStrictEqual(count(dim), [0, 0]);
assert.deepStrictEqual(lines(dim), [4, 5]);

// 3. 右半邊有陰影：原本只抓到亮處的直線，橫線也斷成半條而被丟掉
const shadow = makeImage((x) => (x < 400 ? 230 : 90), (x) => (x < 400 ? 205 : 75));
const before = count(shadow);
assert.ok(before[0] < 4 && before[1] < 5, `陰影圖原本就抓得到？${before}`);
assert.deepStrictEqual(lines(shadow), [4, 5]);

// 4. 只有文字沒有格線：不能憑空生出線
const textOnly = makeImage(() => 200, () => 200);
for (let i = 0; i < textOnly.length; i++) if (textOnly[i] === 200 - 20) textOnly[i] = 60;
assert.deepStrictEqual(lines(textOnly), [0, 0]);

console.log("PASS  格線偵測：清楚／低對比／半邊陰影／只有文字");
