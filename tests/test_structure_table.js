/* 結構模式的「合併儲存格」排列測試（純函式，不需要瀏覽器或模型）。
 * 執行：node tests/test_structure_table.js
 *
 * 為什麼需要這個測試：合併格（colspan／rowspan）只有表格結構模型會給，
 * 而模型的輸出不可控（同一張圖每次猜的合併方式可能不同），
 * 用合成資料直接驗「排列邏輯」最快也最穩。
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(
  path.join(__dirname, "..", "pic-calculator", "static", "ocr-worker.js"), "utf8");

// 抽出純函式（不碰 ort／canvas）
const src = html.match(/function rowsToTable\(rows, words\) \{[\s\S]*?\n\}\n/)[0];
const { rowsToTable } = new Function(src + "\nreturn { rowsToTable };")();

// 一個格子：bbox 用「欄位座標」表示，字框只要落在範圍內就會被收進去
const cell = (x1, y1, x2, y2, extra = {}) => ({
  x1, y1, x2, y2, colspan: 1, rowspan: 1, text: "", score: 1, ...extra,
});
const word = (text, cx, cy, h = 20) => ({ text, cx, cy, h, score: 0.95 });

// ---- 1) rowspan：第 1 欄跨 3 列，後面的列不能再往左擠 ----
const rows = [
  // 第 0 列：一個跨 3 列的「人事費」＋三個數字欄
  [cell(0, 0, 100, 300, { rowspan: 3 }), cell(100, 0, 200, 100), cell(200, 0, 300, 100), cell(300, 0, 400, 100)],
  // 第 1 列：只有三個數字欄（第一欄被上面的 rowspan 佔住）
  [cell(100, 100, 200, 200), cell(200, 100, 300, 200), cell(300, 100, 400, 200)],
  // 第 2 列：同上
  [cell(100, 200, 200, 300), cell(200, 200, 300, 300), cell(300, 200, 400, 300)],
];
const words = [
  word("人事費", 50, 150),
  word("25,000", 150, 50), word("8", 250, 50), word("200,000", 350, 50),
  word("12,000", 150, 150), word("15", 250, 150), word("180,000", 350, 150),
  word("1,400", 150, 250), word("120", 250, 250), word("168,000", 350, 250),
];
const built = rowsToTable(rows, words);
assert.deepStrictEqual(built.grid, [
  ["人事費", "25,000", "8", "200,000"],
  ["", "12,000", "15", "180,000"],
  ["", "1,400", "120", "168,000"],
], "rowspan 之後的列不能整排左移");
assert.deepStrictEqual(built.spans[0][0], { rs: 3, cs: 1 });
assert.strictEqual(built.spans[1][0], null, "被 rowspan 蓋住的格子要標成 null（渲染時跳過）");
assert.strictEqual(built.spans[2][0], null);

// ---- 2) colspan：橫跨兩欄的標題，後面那欄不能被擠掉 ----
const rows2 = [
  [cell(0, 0, 200, 100, { colspan: 2 }), cell(200, 0, 300, 100)],
  [cell(0, 100, 100, 200), cell(100, 100, 200, 200), cell(200, 100, 300, 200)],
];
const built2 = rowsToTable(rows2, [
  word("金額", 100, 50), word("備註", 250, 50),
  word("A", 50, 150), word("1", 150, 150), word("x", 250, 150),
]);
assert.deepStrictEqual(built2.grid[0], ["金額", "", "備註"], "跨兩欄的標題後面要留空欄給 colspan");
assert.deepStrictEqual(built2.spans[0][0], { rs: 1, cs: 2 });
assert.strictEqual(built2.spans[0][1], null);

// ---- 3) 同時有 colspan 與 rowspan ----
const rows3 = [
  [cell(0, 0, 200, 100, { colspan: 2, rowspan: 2 }), cell(200, 0, 300, 100)],
  [cell(200, 100, 300, 200)],
  [cell(0, 200, 100, 300), cell(100, 200, 200, 300), cell(200, 200, 300, 300)],
];
const built3 = rowsToTable(rows3, [
  word("大標", 100, 50), word("X", 250, 50), word("Y", 250, 150),
  word("a", 50, 250), word("b", 150, 250), word("c", 250, 250),
]);
assert.deepStrictEqual(built3.spans[0][0], { rs: 2, cs: 2 });
assert.strictEqual(built3.spans[0][1], null);
assert.strictEqual(built3.spans[1][0], null);
assert.strictEqual(built3.spans[1][1], null);
assert.deepStrictEqual(built3.grid[1], ["", "", "Y"]);
assert.deepStrictEqual(built3.grid[2], ["a", "b", "c"]);

// ---- 4) 沒有任何合併：spans 全部是 1x1，grid 就是原本的內容 ----
const built4 = rowsToTable([[cell(0, 0, 100, 100), cell(100, 0, 200, 100)]], [word("甲", 50, 50), word("乙", 150, 50)]);
assert.deepStrictEqual(built4.grid, [["甲", "乙"]]);
assert.deepStrictEqual(built4.spans, [[{ rs: 1, cs: 1 }, { rs: 1, cs: 1 }]]);

console.log("PASS  結構模式：colspan／rowspan 排列與 spans 標記");
