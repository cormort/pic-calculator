/* 「沿用上一張的驗算設定」純函式測試。
 * 執行：node tests/test_template.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(
  path.join(__dirname, "..", "pic-calculator", "static", "index.html"), "utf8");
const src = ["squashLabel", "templateKey", "columnShape", "makeTemplate", "matchTemplate"]
  .map((fn) => html.match(new RegExp(`function ${fn}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0])
  .join("\n");
const T = new Function(src + "\nreturn { makeTemplate, matchTemplate };")();

// 標籤＝第一個不是數字的格（與 SmartTotals.rowLabel 同概念）
const labelOf = (row) => (row || []).find((v) => v && isNaN(Number(String(v).replace(/,/g, "")))) || "";
const empty = () => ({ plus: [], minus: [], total: null });

const jan = [
  ["科目", "113年1月預算", "113年1月實支", "餘額"],
  ["人事費", "1,000", "800", "200"],
  ["業務費", "500", "450", "50"],
  ["小", "1,500", "1,250", "250"],
];
const sel = { col: { plus: [1], minus: [2], total: 3 }, row: empty() };
const tpl = T.makeTemplate(jan, sel, new Set([3]), labelOf);
assert.ok(tpl);

// 下一張：月份不同、列數不同 → 欄設定照用，手動合計列依標籤對到新的位置
const feb = [
  ["科目", "113年2月預算", "113年2月實支", "餘額"],
  ["人事費", "1,000", "900", "100"],
  ["業務費", "500", "300", "200"],
  ["設備費", "200", "100", "100"],
  ["小", "1,700", "1,300", "400"],
];
const m = T.matchTemplate(tpl, feb, labelOf);
assert.strictEqual(m.ok, true);
assert.deepStrictEqual(m.col, { plus: [1], minus: [2], total: 3 });
assert.deepStrictEqual(m.totals, [4]);
assert.strictEqual(m.row, null);

// 回傳的是複本：套用後再點選不會改到範本
m.col.plus.push(0);
assert.deepStrictEqual(tpl.col.plus, [1]);

// OCR 多切一欄：欄號已經不是原本那一欄，不能套用
const extraCol = feb.map((r) => [...r, ""]);
extraCol[1][4] = "x";
const m2 = T.matchTemplate(tpl, extraCol, labelOf);
assert.strictEqual(m2.ok, false);
assert.match(m2.reason, /欄數不同/);

// 欄數相同但表頭不同 → 是另一種表格
const other = [["品名", "數量", "單價", "金額"], ["A", "1", "2", "2"]];
assert.strictEqual(T.matchTemplate(tpl, other, labelOf).ok, false);

// 列角色依科目名稱對應；對不到（或有兩列同名）就不沿用列設定
const rowSel = { col: empty(), row: { plus: [1, 2], minus: [], total: 3 } };
const rowTpl = T.makeTemplate(jan, rowSel, new Set(), labelOf);
assert.deepStrictEqual(T.matchTemplate(rowTpl, feb, labelOf).row, { plus: [1, 2], minus: [], total: 4 });
const renamed = feb.map((r) => r.slice());
renamed[2][0] = "業務支出";
const m3 = T.matchTemplate(rowTpl, renamed, labelOf);
assert.strictEqual(m3.row, null);
assert.strictEqual(m3.rowSkipped, true);

// 沒有任何設定可記 → null（呼叫端保留更早那一張的範本）
assert.strictEqual(T.makeTemplate(jan, { col: empty(), row: empty() }, new Set(), labelOf), null);

// 標點差異不該讓同一列對不上（OCR 常漏讀「、」；括號也常全形／半形混用）
const punct = [
  ["科目", "113年1月預算", "113年1月實支", "餘額"],
  ["人事費", "1,000", "800", "200"],
  ["業務費（含外包）", "500", "450", "50"],
  ["小計", "1,500", "1,250", "250"],
];
const punctTpl = T.makeTemplate(punct, { col: empty(), row: { plus: [1, 2], minus: [], total: 3 } }, new Set(), labelOf);
const punctNext = [
  ["科目", "113年2月預算", "113年2月實支", "餘額"],
  ["人事費", "1,000", "800", "200"],
  ["業務費(含外包)", "500", "450", "50"],     // 全形括號 → 半形
  ["小計", "1,500", "1,250", "250"],
];
assert.deepStrictEqual(T.matchTemplate(punctTpl, punctNext, labelOf).row,
  { plus: [1, 2], minus: [], total: 3 });

// 科目名稱漏讀「、」也要對得上
const commaTpl = T.makeTemplate(
  [["科目", "金額"], ["不動產、廠房及設備", "100"], ["合計", "100"]],
  { col: { plus: [1], minus: [], total: null }, row: { plus: [1], minus: [], total: 2 } },
  new Set(), labelOf);
assert.deepStrictEqual(
  T.matchTemplate(commaTpl, [["科目", "金額"], ["不動產廠房及設備", "100"], ["合計", "100"]], labelOf).row,
  { plus: [1], minus: [], total: 2 });

// 欄數、表頭都相同，但欄位內容型態不同（金額欄變成文字欄）→ 不沿用。
// 硬套欄角色會產生最危險的結果：錯了卻顯示「驗算正確」
const shapeA = [
  ["科目", "113年1月預算", "113年1月實支", "餘額"],
  ["人事費", "1,000", "800", "200"],
  ["業務費", "500", "450", "50"],
];
const shapeTpl = T.makeTemplate(shapeA, { col: { plus: [1], minus: [2], total: 3 }, row: empty() }, new Set(), labelOf);
const shapeB = [
  ["科目", "113年2月預算", "113年2月實支", "餘額"],
  ["人事費", "說明甲", "說明乙", "說明丙"],
  ["業務費", "說明丁", "說明戊", "說明己"],
];
assert.strictEqual(T.matchTemplate(shapeTpl, shapeB, labelOf).ok, false);
// 型態相同（都還是數字）→ 照樣沿用
const shapeC = shapeB.map((r, i) => i === 0 ? r : r.map((v, j) => j === 0 ? v : "1"));
assert.strictEqual(T.matchTemplate(shapeTpl, shapeC, labelOf).ok, true);

console.log("PASS  沿用上一張設定：欄數／表頭比對、合計列依標籤、列角色依科目、標點差異、欄位型態");
