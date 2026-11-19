/* 版本號與快取清單一致性檢查（純字串比對，不需要瀏覽器）。
 * 執行：node tests/test_versions.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const STATIC = path.join(__dirname, "..", "pic-calculator", "static");
const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf8");
const sw = fs.readFileSync(path.join(STATIC, "sw.js"), "utf8");

const version = (html.match(/const APP_VERSION = '([^']+)'/) || [])[1];
assert.ok(version, "index.html 找不到 APP_VERSION");
const num = version.replace(/^v/, "");

// 1) 所有靜態 CSS／JS 模組都要用同一個 ?v= 版本載入
const versionedAssets = [
  { tag: /<link rel="stylesheet" href="styles\.css(\?v=([^"]*))?"/, file: "styles.css" },
  { tag: /<script src="smart_total\.js(\?v=([^"]*))?"/, file: "smart_total.js" },
  { tag: /<script src="validator\.js(\?v=([^"]*))?"/, file: "validator.js" },
  { tag: /<script src="table_builder\.js(\?v=([^"]*))?"/, file: "table_builder.js" },
  { tag: /<script src="text_amounts\.js(\?v=([^"]*))?"/, file: "text_amounts.js" },
  { tag: /<script src="template\.js(\?v=([^"]*))?"/, file: "template.js" },
];
for (const { tag, file } of versionedAssets) {
  const m = html.match(tag);
  assert.ok(m && m[1], `${file} 沒有帶版本參數`);
  assert.strictEqual(m[1], `?v=${num}`, `${file} 的版本是 ${m[1]}，但 APP_VERSION 是 ${version}`);
}

// 2) worker 也是用 APP_VERSION 組網址
assert.ok(/new Worker\(`ocr-worker\.js\?v=\$\{APP_VERSION\}`/.test(html),
  "ocr-worker.js 沒有用 APP_VERSION 當版本參數");

// 3) Service Worker 的快取名稱要同步
const cacheName = (sw.match(/const CACHE_NAME = '([^']+)'/) || [])[1];
assert.ok(cacheName && cacheName.includes(num), `CACHE_NAME（${cacheName}）沒有對到 APP_VERSION（${version}）`);

// 4) SW 的離線殼清單（SHELL）需涵蓋所有殼檔案
const shellBlock = (sw.match(/const SHELL = \[([\s\S]*?)\];/) || [])[1] || "";
for (const file of ["index.html", "styles.css", "smart_total.js", "validator.js", "table_builder.js", "text_amounts.js", "template.js", "ocr-worker.js", "manifest.json"]) {
  assert.ok(shellBlock.includes(`'${file}'`), `sw.js SHELL 缺少 ${file}`);
}

// 5) 必備 OCR / 版面 / 表格結構模型檔存在，且已移除的模型不再被程式參照
const worker = fs.readFileSync(path.join(STATIC, "ocr-worker.js"), "utf8");
const modelsDir = path.join(STATIC, "models");
for (const file of [
  "PP-OCRv6_tiny_det.ort",
  "PP-OCRv6_tiny_rec.ort",
  "ppocrv6_tiny_dict.txt",
  "PP-OCRv6_small_det.ort",
  "PP-OCRv6_small_rec.ort",
  "ppocrv6_dict.txt",
  "pp_doclayout_s.onnx",
  "slanet_plus.onnx",
]) {
  assert.ok(fs.existsSync(path.join(modelsDir, file)), `models/ 缺少必要模型檔 ${file}`);
}
assert.ok(!/['"]medium['"]|PP-OCRv6_medium_|tatr_quantized\.onnx/.test(html), "index.html 仍參照已移除的 medium 或 TATR 模型");
assert.ok(!/\bmedium\s*:|PP-OCRv6_medium_|tatr_quantized\.onnx/.test(worker), "ocr-worker.js 仍參照已移除的 medium 或 TATR 模型");

console.log(`PASS  版本一致性：APP_VERSION=${version}、靜態模組 ?v=${num}、CACHE_NAME=${cacheName}`);
