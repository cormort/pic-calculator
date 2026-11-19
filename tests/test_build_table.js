/* 前端 buildTable / 選取角色 / 數字整理 / 手動驗算容差的單元測試。
 * 直接 require static/validator.js 與 static/table_builder.js，不需要瀏覽器或 OCR。
 * 執行：node tests/test_build_table.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  Validator,
  repairNumericCells,
  emptySel,
  setRoleOn,
  removeSelOn,
  addRangeOn,
  selCountOf,
  selReadyOf,
  autoTotalIndexOf,
  selIndicesOf,
  selSignsOf,
} = require("../pic-calculator/static/validator.js");
const { buildTable } = require("../pic-calculator/static/table_builder.js");

const html = fs.readFileSync(
  path.join(__dirname, "..", "pic-calculator", "static", "index.html"), "utf8");

const repairCells = repairNumericCells;

// 幣別與手寫打勾不影響數字解析
assert.strictEqual(Validator._num("NT$ 122,226"), 122226);
assert.strictEqual(Validator._num("V NT$ 2,353"), 2353);
assert.strictEqual(Validator._num("JN NT$ 24,900"), 24900);
assert.strictEqual(Validator._num("NTS 1,170,285"), 1170285);
assert.strictEqual(Validator._num("√ 9,900"), 9900);
assert.strictEqual(Validator._num("√ NT$ 833,000"), 833000);
// 手寫勾被讀成 1 或 | 黏在金額前面
assert.strictEqual(Validator._num("1 NTS 2,353"), 2353);
assert.strictEqual(Validator._num("| NT$ 20,000"), 20000);
assert.strictEqual(Validator._num("I NTS 1,170,285"), 1170285);
// 但真的以數字開頭、後面沒有幣別的內容不能被吃掉
assert.strictEqual(Validator._num("1 件"), NaN);
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
// 數字後面緊黏「長得像數字的字母」是辨識錯（200 讀成 2OO），不是幣別
assert.ok(isNaN(Validator._num("2OO")));
assert.ok(isNaN(Validator._num("1,0l")));
assert.ok(isNaN(Validator._num("5S")));
assert.strictEqual(Validator._num("100USD"), 100);
// OCR 流程裡仍會自動修回 200
assert.strictEqual(repairCells([["金額"], ["2OO"], ["1,000"]], null).data[1][0], "200");

const w = (text, x1, x2, cy, score = 1, h = 20) => ({
  text, x1, x2, y1: cy - h / 2, y2: cy + h / 2,
  cx: (x1 + x2) / 2, cy, h, score,
});

// 表頭置中、數字右對齊：空白帶切欄應為 3 欄
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

// 同一格合併多個文字框時，信心取最小值，y 範圍取聯集
const merged = buildTable([
  { text: "1,234", x1: 10, x2: 60, y1: 90, y2: 110, cx: 35, cy: 100, h: 20, score: 0.9 },
  { text: "567", x1: 62, x2: 100, y1: 85, y2: 118, cx: 81, cy: 101, h: 20, score: 0.4 },
  w("8,900", 300, 360, 100, 0.95),
]);
assert.strictEqual(merged.confidence[0][0], 0.4);
assert.deepStrictEqual(merged.boxes[0][0], { x1: 10, x2: 100, y1: 85, y2: 118 });

// 歪斜照片（~5°）：buildTable 分列用旋轉後座標，但 cellBoxes 需保留未旋轉的原圖座標給原圖對照
const rad = 5 * Math.PI / 180;
const rot = (x, y) => [x * Math.cos(rad) - y * Math.sin(rad), x * Math.sin(rad) + y * Math.cos(rad)];
const skewWords = [
  ["科目", 50, 100, 100], ["金額", 400, 100, 100],
  ["租金", 50, 150, 150], ["10,000", 400, 150, 150],
  ["水電", 50, 200, 200], ["2,000", 400, 200, 200],
].map(([text, x, y]) => {
  const [rx, ry] = rot(x, y);
  return w(text, rx - 30, rx + 30, ry);
});
const skewBuilt = buildTable(skewWords);
assert.strictEqual(skewBuilt.data.length, 3);
assert.deepStrictEqual(skewBuilt.boxes[2][1], {
  x1: skewWords[5].x1, x2: skewWords[5].x2, y1: skewWords[5].y1, y2: skewWords[5].y2,
});

// 欄位塞滿數字、欄距比字高還小：仍要切成兩欄
const narrow = buildTable([
  w("科目", 20, 80, 100), w("合計", 200, 240, 100), w("本校", 330, 370, 100),
  w("業務收入", 20, 110, 150), w("20,622,869", 150, 270, 150), w("20,084,844", 280, 400, 150),
  w("業務成本", 20, 110, 200), w("22,481,607", 150, 270, 200), w("22,004,357", 280, 400, 200),
]);
assert.deepStrictEqual(narrow.data[1], ["業務收入", "20,622,869", "20,084,844"]);
assert.deepStrictEqual(narrow.data[2], ["業務成本", "22,481,607", "22,004,357"]);

// 紙張微捲曲：同一列各欄 y 有非線性微幅偏移，仍應合併為同一列
const curved = buildTable([
  w("項目", 20, 80, 100), w("100", 220, 260, 106), w("200", 420, 460, 113),
  w("總計", 20, 80, 150), w("100", 220, 260, 150), w("200", 420, 460, 150),
]);
assert.deepStrictEqual(curved.data, [
  ["項目", "100", "200"],
  ["總計", "100", "200"],
]);

// 偵測把兩欄數字框成同一個框：拆回兩格
const oneBox = buildTable([
  w("業務收入", 20, 110, 150), w("20,622,869 20,084,844", 150, 400, 150),
  w("業務成本", 20, 110, 200), w("22,481,607 22,004,357", 150, 400, 200),
]);
assert.deepStrictEqual(oneBox.data[0], ["業務收入", "20,622,869", "20,084,844"]);

// 同一個數字被切開（斷點帶逗號）：照舊合併成一格
const broken = buildTable([w("22,481,", 150, 230, 150), w("607", 240, 270, 150), w("9,000", 500, 560, 150)]);
assert.deepStrictEqual(broken.data[0], ["22,481, 607", "9,000"]);

// 有格線：線就是欄界；橫線之間的兩行表頭併回一列
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

// 同一格被偵測兩次（「人」與「人事費」大幅重疊）→ 留字多的那個
const dupCell = buildTable([
  w("項次", 30, 90, 100), w("會計科目", 150, 260, 100),
  w("人", 100, 175, 150), w("人事費", 120, 240, 150),
], { v: [10, 130, 320].map(vline), h: [80, 130, 180].map(hline) });
assert.deepStrictEqual(dupCell.data[1], ["", "人事費"]);

// 整欄都沒字（陰影／紙緣被當成格線）→ 去掉那一欄
const emptyCol = buildTable([
  w("科目", 30, 90, 100), w("金額", 300, 360, 100),
  w("租金", 30, 80, 150), w("12,000", 300, 360, 150),
  w("水電", 30, 80, 200), w("3,500", 300, 360, 200),
], { v: [10, 120, 250, 400].map(vline), h: [80, 130, 180, 230].map(hline) });
assert.deepStrictEqual(emptyCol.data[0], ["科目", "金額"]);
assert.deepStrictEqual(emptyCol.data[1], ["租金", "12,000"]);

// 欄／列角色：加項、減項、合計、乘除與固定 3 個數
const sel = { col: emptySel(), row: emptySel() };
const setRole = (kind, idx, role) => setRoleOn(sel, kind, idx, role);
const removeSel = (kind, idx) => removeSelOn(sel, kind, idx);
const addRange = (kind, idx) => addRangeOn(sel, kind, idx, 1);
const selCount = (kind) => selCountOf(sel, kind);
const selReady = (kind) => selReadyOf(sel, kind);
const autoTotalIndex = (kind) => autoTotalIndexOf(sel, kind);
const selIndices = (kind) => selIndicesOf(sel, kind);
const selSigns = (kind) => selSignsOf(sel, kind);
const resetSel = () => { sel.col = emptySel(); sel.row = emptySel(); };

resetSel();
setRole("col", 0, 1);
setRole("col", 1, 1);
setRole("col", 4, 0);
assert.deepStrictEqual(selIndices("col"), [0, 1, 4]);
assert.deepStrictEqual([...selSigns("col").entries()], [[0, 1], [1, 1]]);
assert.strictEqual(selCount("col"), 3);

setRole("col", 1, 1);
assert.deepStrictEqual(selIndices("col"), [0, 4]);

setRole("col", 0, -1);
assert.deepStrictEqual([...selSigns("col").entries()], [[0, -1]]);

setRole("col", 0, 0);
assert.deepStrictEqual(selIndices("col"), [0]);

resetSel();
setRole("col", 2, 1); setRole("col", 3, 1);
assert.strictEqual(autoTotalIndex("col"), 3);
assert.deepStrictEqual(selIndices("col"), [2, 3]);
assert.deepStrictEqual([...selSigns("col").entries()], [[2, 1], [3, 1]]);

setRole("col", 2, 0);
assert.strictEqual(autoTotalIndex("col"), null);
assert.deepStrictEqual(selIndices("col"), [3, 2]);

resetSel();
setRole("col", 5, 1);
assert.strictEqual(autoTotalIndex("col"), null);
assert.deepStrictEqual(selIndices("col"), [5]);

resetSel();
setRole("col", 1, 1); setRole("col", 5, 0);
addRange("col", 3);
assert.deepStrictEqual(selIndices("col"), [1, 2, 3, 5]);

removeSel("col", 2);
assert.deepStrictEqual(selIndices("col"), [1, 3, 5]);

// 乘除：固定 3 個、切換運算清除舊合計、滿 3 個後仍可改指等於欄
resetSel();
setRole("col", 0, 2); setRole("col", 1, 2);
assert.strictEqual(selReady("col"), false);
setRole("col", 2, 2);
assert.strictEqual(selReady("col"), true);
assert.deepStrictEqual(selIndices("col"), [0, 1, 2]);
assert.strictEqual(setRole("col", 3, 2), "full");
assert.deepStrictEqual(selIndices("col"), [0, 1, 2]);
setRole("col", 4, 1);
assert.deepStrictEqual(selIndices("col"), [4]);

resetSel();
setRole("col", 0, 1); setRole("col", 1, 1); setRole("col", 4, 0);
setRole("col", 2, -2);   // 從加減換到除法 → 舊的 total=4 也要一起清掉
assert.strictEqual(sel.col.total, null);
assert.deepStrictEqual(selIndices("col"), [2]);

resetSel();
setRole("col", 3, 0); setRole("col", 0, -2); setRole("col", 1, -2);
assert.deepStrictEqual(selIndices("col"), [0, 1, 3]);
assert.strictEqual(selReady("col"), true);
// 已有 3 個且已指定 ＝ 在 3，允許改指 ＝ 到 4
assert.strictEqual(setRole("col", 4, 0), undefined);
assert.deepStrictEqual(selIndices("col"), [0, 1, 4]);

// Validator._evalManual 與收緊後的容差（大額與除法）
const ev = (vals, roles) => Validator._evalManual(vals.map((_, i) => i), i => vals[i], new Map(roles.map((r, i) => [i, r])));
assert.strictEqual(ev([120, 3], [2, 2]), 360);
assert.strictEqual(ev([360, 3], [-2, -2]), 120);
assert.strictEqual(ev([3, 360], [-2, -2]), 3 / 360);
assert.strictEqual(ev([100, 0], [-2, -2]), null);
assert.strictEqual(ev([1, 2, 3], [2, 2, 2]), null);
assert.strictEqual(ev([100, 200, 50], [1, 1, -1]), 250);

// 1,000 萬差 5,000 不可再被當成相符；除法比率小於 1 也不會被 1.0 絕對容差吃掉
const vBig = Validator.validate({
  mode: "horizontal",
  sheetData: [["A", "B", "合計"], ["5,000,000", "5,000,000", "10,005,000"]],
  headerRow: 1, endRow: 0, startCol: 1, endCol: 0,
  selectedIndices: [0, 1, 2],
  selectedSigns: new Map([[0, 1], [1, 1]]),
  keywords: { trigger: [], exclude: [] }, sumDirection: "bottom",
});
assert.strictEqual(vBig.errorCount, 1, "10,000,000 vs 10,005,000 必須報錯");
assert.strictEqual(Validator.hasErr(1, 2), true);
assert.strictEqual(Validator.isOk(1, 2), false);
assert.ok(Validator.errors.has("1,2"), "Validator.errors 應使用字串鍵 'r,c'");

const vDiv = Validator.validate({
  mode: "horizontal",
  sheetData: [["被除", "除", "商"], ["3", "360", "0.5"]],
  headerRow: 1, endRow: 0, startCol: 1, endCol: 0,
  selectedIndices: [0, 1, 2],
  selectedSigns: new Map([[0, -2], [1, -2]]),
  keywords: { trigger: [], exclude: [] }, sumDirection: "bottom",
});
assert.strictEqual(vDiv.errorCount, 1, "除法 3/360 vs 0.5 必須報錯");

// 全形數字、句點被讀成千分位
assert.strictEqual(Validator._num("２００,０００"), 200000);
assert.strictEqual(Validator._num("1.920.497"), 1920497);
assert.strictEqual(Validator._num("－25,000"), -25000);
assert.strictEqual(Validator._num("1.920,497"), 1920497);
assert.strictEqual(Validator._num("3,766.807"), 3766807);

// 偵測框跨過格線：「1-1主」依線拆回項次與科目
const straddle = buildTable([
  w("項次", 30, 90, 100), w("會計科目", 150, 260, 100), w("金額", 400, 470, 100),
  w("1-1主", 20, 175, 150), w("主持人費", 165, 300, 150), w("200,000", 380, 500, 150),
  w("1-2兼", 20, 175, 200), w("兼任助理", 165, 300, 200), w("180,000", 380, 500, 200),
], { v: [10, 130, 360, 520].map(vline), h: [80, 130, 180, 230].map(hline) });
assert.deepStrictEqual(straddle.data[1], ["1-1", "主持人費", "200,000"]);
assert.deepStrictEqual(straddle.data[2], ["1-2", "兼任助理", "180,000"]);

// 不要拆斷一個完整數字
const noSplit = buildTable([
  w("20,622,869", 100, 260, 150),
  w("20,084,844", 100, 260, 200),
], { v: [10, 180, 300].map(vline), h: [] });
assert.deepStrictEqual(noSplit.data[0][0], "20,622,869");

// 數字整理：混淆字（O→0、l→1）、全形、千分位句點，且表頭的年份／羅馬字母不受誤傷
const raw = [["項次", "收入", "金額"], ["1", "(1.920.497)", "O"], ["2", "３０００", "l"]];
const rep = repairCells(raw.map(r => r.slice()), [[1, 1, 1], [1, 1, 0.7], [1, 1, 0.7]]);
assert.deepStrictEqual(rep.data[1], ["1", "(1,920,497)", "0"]);
assert.strictEqual(Validator._num("(1.920.497)"), -1920497);
assert.deepStrictEqual(rep.data[2], ["2", "3,000", "1"]);
assert.ok(rep.repairs.length >= 4);

const hdrProtect = repairCells([
  ["科目", "2024", "2025", "I", "S"],
  ["租金", "1000", "2000", "3000", "4000"],
  ["水電", "500", "600", "700", "800"],
], null, 1);
assert.deepStrictEqual(hdrProtect.data[0], ["科目", "2024", "2025", "I", "S"], "表頭年份與字母不可被改");
assert.deepStrictEqual(hdrProtect.data[1], ["租金", "1,000", "2,000", "3,000", "4,000"]);

// 單組「25.000」與漏第 2 個逗號的 7 位數（「2.473150」）要靠整欄都是千分位才轉
const repCol = repairCells([["單價"], ["25.000"], ["2.473150"], ["(6.084377)"], ["12,000"]], null);
assert.deepStrictEqual(repCol.data[1], ["25,000"]);
assert.deepStrictEqual(repCol.data[2], ["2,473,150"]);
assert.deepStrictEqual(repCol.data[3], ["(6,084,377)"]);
const repOrder = repairCells([["金額"], ["969.524"], ["1.920,497"], ["2.890.021"]], null);
assert.deepStrictEqual(repOrder.data.slice(1), [["969,524"], ["1,920,497"], ["2,890,021"]]);
const repKeep = repairCells([["單價"], ["25.000"], ["1.234567"], ["0.125000"], ["12.5"]], null);
assert.strictEqual(repKeep.data[1][0], "25.000");
assert.strictEqual(repKeep.data[2][0], "1.234567");
assert.strictEqual(repKeep.data[3][0], "0.125000");
const repDec = repairCells([["單價"], ["1.50"], ["12,345.60"]], null);
assert.deepStrictEqual(repDec.data.slice(1), [["1.50"], ["12,345.60"]]);
assert.strictEqual(repDec.repairs.length, 0);

// 每個 inline 事件呼叫的函式都要存在於 index.html
const handlers = new Set([...html.matchAll(/\son\w+="(\w+)\(/g)].map((m) => m[1]));
for (const fn of handlers) {
  assert.ok(new RegExp(`function ${fn}\\(`).test(html), `inline handler ${fn}() 未定義`);
}

console.log("PASS  frontend buildTable / confidence / range selection / numeric repair");
