/* 前端 buildTable / Shift 連續選取的單元測試。
 * 直接從 index.html 抽出這兩個純函式，不需要瀏覽器或 OCR。
 * 執行：node tests/test_build_table.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(
  path.join(__dirname, "..", "pic-calculator", "static", "index.html"), "utf8");
const buildSrc = html.match(/function buildTable\(words\) \{[\s\S]*?\n\}\n\nasync function analyzeImage/)[0]
  .replace(/\n\nasync function analyzeImage$/, "");
const rangeSrc = html.match(/function selectRange\(arr, anchor, idx\) \{[\s\S]*?\n\}\n\nfunction cycleSelection/)[0]
  .replace(/\n\nfunction cycleSelection$/, "");

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
const Validator = {
  _num(v) {
    if (v === null || v === undefined || v === "") return NaN;
    if (typeof v === "number") return v;
    let s = v.toString().trim();
    if (s === "") return NaN;
    if (/[a-zA-Z一-龥]/.test(s)) return NaN;
    if (!/^[-\d\.,，\(\)\$%\s]+$/.test(s)) return NaN;
    s = s.replace(/[,，\$\s]/g, "").replace(/[%％]/g, "");
    if (s.startsWith("(") && s.endsWith(")")) s = "-" + s.replace(/[\(\)]/g, "");
    const n = parseFloat(s);
    return isNaN(n) ? NaN : n;
  },
};
let signs = new Map();
eval(buildSrc);
eval(rangeSrc);

const w = (text, x1, x2, cy, score = 1, h = 20) => ({
  text, x1, x2, y1: cy - h / 2, y2: cy + h / 2,
  cx: (x1 + x2) / 2, cy, h, score,
});

// 表頭置中、數字右對齊：舊的中心點分群會拆成 5 欄，空白帶切欄應為 3 欄
const words = [
  w("科目", 44, 107, 100), w("本年", 653, 722, 100), w("上年", 1013, 1081, 100),
  w("營業收入", 53, 161, 150, 0.70), w("1,234,567", 744, 863, 150, 0.80), w("1,111,222", 1104, 1224, 150, 0.90),
  w("營業成本", 53, 161, 200, 0.75), w("(987,654)", 745, 861, 200, 0.85), w("(900,000)", 1106, 1222, 200, 0.95),
];
const built = buildTable(words);
assert.deepStrictEqual(built.data, [
  ["科目", "本年", "上年"],
  ["營業收入", "1,234,567", "1,111,222"],
  ["營業成本", "(987,654)", "(900,000)"],
]);
assert.deepStrictEqual(built.confidence[1], [0.7, 0.8, 0.9]);

// 同一格合併多個文字框時，信心取最小值
const merged = buildTable([
  w("1,234", 10, 60, 100, 0.9), w("567", 62, 100, 100, 0.4),
  w("8,900", 300, 360, 100, 0.95),
]);
assert.strictEqual(merged.confidence[0][0], 0.4);

// Shift 連續選取
let arr = [3];
signs = new Map();
selectRange(arr, 3, 6);
assert.deepStrictEqual(arr, [3, 4, 5, 6]);
assert.strictEqual(signs.get(5), 1);

arr = [10];
selectRange(arr, 10, 3);
assert.deepStrictEqual(arr, [3, 4, 5, 6, 7, 8, 9, 10]);

// 已選合計 10、Shift 選 4-8：合計 10 保留在最後
arr = [3, 4, 10];
selectRange(arr, 4, 8);
assert.deepStrictEqual(arr, [3, 4, 5, 6, 7, 8, 10]);

console.log("PASS  frontend buildTable / confidence / range selection");
