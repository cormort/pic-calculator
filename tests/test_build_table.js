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
// 欄／列的驗算角色（加項／減項／合計）是純邏輯，直接抽出來測
const selSrc = [
  html.match(/const sel = \{[\s\S]*?let selMode = 1;/)[0],
  ...["setRole", "removeSel", "addRange", "selCount", "selIndices", "selSigns"]
    .map((fn) => html.match(new RegExp(`function ${fn}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0]),
].join("\n");

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
// 用 index.html 裡真正的數字解析，避免測試與實作各寫一份
const numSrc = html.match(/  _num\(v\) \{[\s\S]*?\n  \},/)[0];
// _num 會用到全形轉換與千分位修正，helper 一起抽出來（同一個 eval 才看得到彼此）
const helperSrc = html.match(/const FULLWIDTH_MAP[\s\S]*?\nfunction repairNumericCells[\s\S]*?\n\}\n/)[0];
const helpers = eval(helperSrc + "\n;({ Validator: ({" + numSrc + "}), repairNumericCells })");
const Validator = helpers.Validator;
const repairCells = helpers.repairNumericCells;  // eval 會把同名 function 留在作用域，換個名字

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
// 數字後面緊黏「長得像數字的字母」是辨識錯（200 讀成 2OO），不是幣別：不能悄悄當成 2
assert.ok(isNaN(Validator._num("2OO")));
assert.ok(isNaN(Validator._num("1,0l")));
assert.ok(isNaN(Validator._num("5S")));
assert.strictEqual(Validator._num("1,000元"), 1000);
assert.strictEqual(Validator._num("20,000 NTD"), 20000);
assert.strictEqual(Validator._num("100USD"), 100);
// OCR 流程裡仍會自動修回 200（修錯的話驗算會抓到）
assert.strictEqual(repairCells([["金額"], ["2OO"], ["1,000"]], null).data[1][0], "200");

// buildTable 會用到字寬估算與「跨格線拆框」
eval(html.match(/function charWidth\(ch\) \{[\s\S]*?\n\}\n/)[0]);
eval(html.match(/function splitBoxAtLine\(w, vLines\) \{[\s\S]*?\n\}\n/)[0]);

eval(buildSrc);   // 選取角色（selSrc）留到最後再 eval，避免蓋掉測試自己的變數

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

// 同一格被偵測兩次（「人」與「人事費」大幅重疊）→ 留字多的那個，不要疊字
const dupCell = buildTable([
  w("項次", 30, 90, 100), w("會計科目", 150, 260, 100),
  w("人", 100, 175, 150), w("人事費", 120, 240, 150),
], { v: [10, 130, 320].map(vline), h: [80, 130, 180].map(hline) });
assert.deepStrictEqual(dupCell.data[1], ["", "人事費"]);

// 整欄都沒字（陰影／紙緣被當成格線）→ 去掉那一欄，表頭才不會與數字錯開
const emptyCol = buildTable([
  w("科目", 30, 90, 100), w("金額", 300, 360, 100),
  w("租金", 30, 80, 150), w("12,000", 300, 360, 150),
  w("水電", 30, 80, 200), w("3,500", 300, 360, 200),
], { v: [10, 120, 250, 400].map(vline), h: [80, 130, 180, 230].map(hline) });
assert.deepStrictEqual(emptyCol.data[0], ["科目", "金額"]);
assert.deepStrictEqual(emptyCol.data[1], ["租金", "12,000"]);

// 欄／列角色：加項、減項、合計（先選角色再點欄號）
// 用 Function 包一層，避免 eval 的 function 宣告蓋到測試自己的名字
const selCtx = new Function(selSrc + "\n; return { sel, setRole, removeSel, addRange, selCount, selIndices, selSigns };")();
const { sel, setRole, removeSel, addRange, selCount, selIndices, selSigns } = selCtx;
const resetSel = () => { sel.col = { plus: [], minus: [], total: null }; sel.row = { plus: [], minus: [], total: null }; };
resetSel();
setRole("col", 0, 1);            // 第1欄 加項
setRole("col", 1, 1);            // 第2欄 加項
setRole("col", 4, 0);            // 第5欄 合計
assert.deepStrictEqual(selIndices("col"), [0, 1, 4]);      // 合計一定在最後
assert.deepStrictEqual([...selSigns("col").entries()], [[0, 1], [1, 1]]);
assert.strictEqual(selCount("col"), 3);

// 同一個角色再點一次 → 取消
setRole("col", 1, 1);
assert.deepStrictEqual(selIndices("col"), [0, 4]);

// 直接換角色（不用先取消）
setRole("col", 0, -1);
assert.deepStrictEqual([...selSigns("col").entries()], [[0, -1]]);

// 合計只能一個：指定新的合計，舊的合計會變成沒角色
setRole("col", 0, 0);
assert.deepStrictEqual(selIndices("col"), [0]);

// 沒指定合計時，沿用最後一個加項當合計（與舊行為一致）
resetSel();
setRole("col", 2, 1); setRole("col", 3, 1);
assert.deepStrictEqual(selIndices("col"), [2, 3, 3]);

// Shift 連續選取：錨點到目標整段設成加項，合計保留在最後
resetSel();
setRole("col", 1, 1); setRole("col", 5, 0);
addRange("col", 3);
assert.deepStrictEqual(selIndices("col"), [1, 2, 3, 5]);

// 點 chip 取消單一欄
removeSel("col", 2);
assert.deepStrictEqual(selIndices("col"), [1, 3, 5]);

// 全形數字、句點被讀成千分位
assert.strictEqual(Validator._num("２００,０００"), 200000);
assert.strictEqual(Validator._num("1.920.497"), 1920497);
assert.strictEqual(Validator._num("－25,000"), -25000);
assert.strictEqual(Validator._num("3,766.807"), 3766807);

// 偵測框跨過格線：「1-1主」依線拆回項次與科目，欄位不會整列右移
const straddle = buildTable([
  w("項次", 30, 90, 100), w("會計科目", 150, 260, 100), w("金額", 400, 470, 100),
  w("1-1主", 20, 175, 150), w("主持人費", 165, 300, 150), w("200,000", 380, 500, 150),
  w("1-2兼", 20, 175, 200), w("兼任助理", 165, 300, 200), w("180,000", 380, 500, 200),
], { v: [10, 130, 360, 520].map(vline), h: [80, 130, 180, 230].map(hline) });
assert.deepStrictEqual(straddle.data[1], ["1-1", "主持人費", "200,000"]);
assert.deepStrictEqual(straddle.data[2], ["1-2", "兼任助理", "180,000"]);

// 不要拆斷一個完整數字：格線剛好落在數字中間時維持原樣
const noSplit = buildTable([
  w("20,622,869", 100, 260, 150),
  w("20,084,844", 100, 260, 200),
], { v: [10, 180, 300].map(vline), h: [] });
assert.deepStrictEqual(noSplit.data[0][0], "20,622,869");

// 數字整理：混淆字（O→0、l→1）、全形、千分位句點
const raw = [["項次", "收入", "金額"], ["1", "(1.920.497)", "O"], ["2", "３０００", "l"]];
const rep = repairCells(raw.map(r => r.slice()), [[1, 1, 1], [1, 1, 0.7], [1, 1, 0.7]]);
assert.deepStrictEqual(rep.data[1], ["1", "(1,920,497)", "0"]);  // 括號負數保持原樣，但千分位要修對
assert.strictEqual(Validator._num("(1.920.497)"), -1920497);
assert.deepStrictEqual(rep.data[2], ["2", "3,000", "1"]);
assert.ok(rep.repairs.length >= 4);

// 單組「25.000」要靠整欄都是千分位才轉
const repCol = repairCells([["單價"], ["25.000"], ["12,000"]], null);
assert.deepStrictEqual(repCol.data[1], ["25,000"]);
// 沒有同欄證據時不要亂改（可能真的是小數）
const repKeep = repairCells([["單價"], ["25.000"], ["12.5"]], null);
assert.strictEqual(repKeep.data[1][0], "25.000");
// 小數尾端的 0 要保留：「1.50」不該被當成「已自動整理」改成「1.5」
const repDec = repairCells([["單價"], ["1.50"], ["12,345.60"]], null);
assert.deepStrictEqual(repDec.data.slice(1), [["1.50"], ["12,345.60"]]);
assert.strictEqual(repDec.repairs.length, 0);

// 每個 inline 事件（onclick="foo(…)"）呼叫的函式都要存在：
// 曾經在重構時誤刪 onCellEdit，格子改了卻不寫回、不重算，也沒有任何錯誤提示
const handlers = new Set([...html.matchAll(/\son\w+="(\w+)\(/g)].map((m) => m[1]));
for (const fn of handlers) {
  assert.ok(new RegExp(`function ${fn}\\(`).test(html), `inline handler ${fn}() 未定義`);
}

console.log("PASS  frontend buildTable / confidence / range selection / numeric repair");
