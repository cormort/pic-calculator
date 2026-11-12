/* 前端 buildTable / Shift 連續選取的單元測試。
 * 直接從 index.html 抽出這兩個純函式，不需要瀏覽器或 OCR。
 * 執行：node tests/test_build_table.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(
  path.join(__dirname, "..", "pic-calculator", "static", "index.html"), "utf8");
const buildSrc = html.match(/function buildTable\(words, grid\) \{[\s\S]*?\n\}\n\nasync function analyzeImage/)[0]
  .replace(/\n\nasync function analyzeImage$/, "");
const rangeSrc = html.match(/function selectRange\(arr, anchor, idx\) \{[\s\S]*?\n\}\n\nfunction cycleSelection/)[0]
  .replace(/\n\nfunction cycleSelection$/, "");

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
// 用 index.html 裡真正的數字解析，避免測試與實作各寫一份
const numSrc = html.match(/  _num\(v\) \{[\s\S]*?\n  \},/)[0];
const Validator = eval("({" + numSrc + "})");

// 幣別與手寫打勾不影響數字解析
assert.strictEqual(Validator._num("NT$ 122,226"), 122226);
assert.strictEqual(Validator._num("V NT$ 2,353"), 2353);
assert.strictEqual(Validator._num("JN NT$ 24,900"), 24900);
assert.strictEqual(Validator._num("NTS 1,170,285"), 1170285);
assert.strictEqual(Validator._num("√ 9,900"), 9900);
assert.strictEqual(Validator._num("√ NT$ 833,000"), 833000);
assert.ok(isNaN(Validator._num("營業收入")));
assert.strictEqual(Validator._num("USD 1,200"), 1200);
assert.strictEqual(Validator._num("NI$ 300"), 300);
assert.strictEqual(Validator._num("20,000 NTD"), 20000);
assert.strictEqual(Validator._num("1,000元"), 1000);
assert.strictEqual(Validator._num("NT$ (500)"), -500);
assert.strictEqual(Validator._num("NT$ -166,981"), -166981);
assert.strictEqual(Validator._num("95, 500"), 95500);
assert.ok(isNaN(Validator._num("Q3 2024")));
assert.ok(isNaN(Validator._num("2023 vs 2024")));
assert.ok(isNaN(Validator._num("1100 現金")));
assert.ok(isNaN(Validator._num("Grand total 1,000 dollars")));

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

// 欄位塞滿數字、欄距比字高還小（實拍：合計 / 臺灣大學 兩欄）：仍要切成兩欄
const narrow = buildTable([
  w("科目", 20, 80, 100), w("合計", 200, 240, 100), w("本校", 330, 370, 100),
  w("業務收入", 20, 110, 150), w("20,622,869", 150, 270, 150), w("20,084,844", 280, 400, 150),
  w("業務成本", 20, 110, 200), w("22,481,607", 150, 270, 200), w("22,004,357", 280, 400, 200),
]);
assert.deepStrictEqual(narrow.data[1], ["業務收入", "20,622,869", "20,084,844"]);
assert.deepStrictEqual(narrow.data[2], ["業務成本", "22,481,607", "22,004,357"]);

// 偵測把兩欄數字框成同一個框：拆回兩格
const oneBox = buildTable([
  w("業務收入", 20, 110, 150), w("20,622,869 20,084,844", 150, 400, 150),
  w("業務成本", 20, 110, 200), w("22,481,607 22,004,357", 150, 400, 200),
]);
assert.deepStrictEqual(oneBox.data[0], ["業務收入", "20,622,869", "20,084,844"]);

// 同一個數字被切開（斷點帶逗號）：照舊合併成一格
const broken = buildTable([w("22,481,", 150, 230, 150), w("607", 240, 270, 150), w("9,000", 500, 560, 150)]);
assert.deepStrictEqual(broken.data[0], ["22,481, 607", "9,000"]);

// 有格線：線就是欄界，欄距再窄、表頭再寬都不會併欄；橫線之間的兩行表頭併回一列
const vline = x => ({ a: x, b: 0 }), hline = y => ({ a: y, b: 0 });
const gridWords = [
  w("科目", 20, 80, 110), w("合計", 200, 240, 100), w("臺灣大學(大", 276, 404, 100), w("學)", 320, 360, 122),
  w("業務收入", 20, 110, 150), w("20,622,869", 150, 272, 150), w("20,084,844", 278, 400, 150),
  w("業務成本", 20, 110, 200), w("22,481,607 22,004,357", 150, 400, 200),
];
const withGrid = buildTable(gridWords, {
  v: [10, 140, 275, 410].map(vline),
  h: [85, 135, 175, 225].map(hline),
});
assert.deepStrictEqual(withGrid.data, [
  ["科目", "合計", "臺灣大學(大學)"],
  ["業務收入", "20,622,869", "20,084,844"],
  ["業務成本", "22,481,607", "22,004,357"],
]);

// 少抓一條線：線之間仍由空白帶補切
const missing = buildTable([
  w("A", 20, 60, 150), w("1,000", 150, 200, 150), w("2,000", 300, 350, 150),
  w("B", 20, 60, 200), w("3,000", 150, 200, 200), w("4,000", 300, 350, 200),
], { v: [10, 100, 400].map(vline), h: [] });
assert.deepStrictEqual(missing.data[0], ["A", "1,000", "2,000"]);

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
