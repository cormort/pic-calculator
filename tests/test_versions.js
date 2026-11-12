/* 版本號一致性檢查（純字串比對，不需要瀏覽器）。
 * 執行：node tests/test_versions.js
 *
 * 為什麼需要：worker 與 smart_total.js 都是用「?v=版本」載入的，
 * 忘記一起改就會讓使用者的瀏覽器一直跑舊檔（實際踩過：改了 smart_total.js
 * 但頁面載入的是快取版本，行為完全沒變，追了很久）。
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

// 1) smart_total.js 要用同一個版本載入
const smartTag = (html.match(/<script src="smart_total\.js(\?v=([^"]*))?"/) || [])[1];
assert.ok(smartTag, "smart_total.js 沒有帶版本參數 —— 改版後使用者會跑到快取舊檔");
assert.strictEqual(smartTag, `?v=${num}`, `smart_total.js 的版本是 ${smartTag}，但 APP_VERSION 是 ${version}`);

// 2) worker 也是用 APP_VERSION 組網址
assert.ok(/new Worker\(`ocr-worker\.js\?v=\$\{APP_VERSION\}`/.test(html),
  "ocr-worker.js 沒有用 APP_VERSION 當版本參數");

// 3) Service Worker 的快取名稱要同步
const cacheName = (sw.match(/const CACHE_NAME = '([^']+)'/) || [])[1];
assert.ok(cacheName && cacheName.includes(num), `CACHE_NAME（${cacheName}）沒有對到 APP_VERSION（${version}）`);

console.log(`PASS  版本一致性：APP_VERSION=${version}、smart_total.js?v=${num}、CACHE_NAME=${cacheName}`);
