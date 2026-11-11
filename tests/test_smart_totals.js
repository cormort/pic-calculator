/* 智慧合計純函式的單元測試（不需瀏覽器、不需 OCR）。
 * 執行：node tests/test_smart_totals.js
 */
const assert = require("assert");
const SmartTotals = require("../pic-calculator/static/smart_total.js");

function parseNum(v) {
  if (v === null || v === undefined) return NaN;
  let s = String(v).trim();
  if (!s || s === "-" || s === "－") return NaN;
  if (/[a-zA-Z一-鿿]/.test(s)) return NaN;
  s = s.replace(/[,，$\s]/g, "").replace(/[%％]/g, "");
  if (s.startsWith("(") && s.endsWith(")")) s = "-" + s.replace(/[()]/g, "");
  const n = parseFloat(s);
  return Number.isNaN(n) ? NaN : n;
}

const tolerance = (v) => Math.max(2, Math.abs(v) * 0.00001);

const table = [
  ["科目", "106年度", "105年度"],
  ["流動資產"],
  ["現金及約當現金", "1,920,497", "1,899,302"],
  ["其他流動資產", "969,524", "1,071,262"],
  ["流動資產合計", "2,890,021", "2,970,564"],
  ["非流動資產"],
  ["不動產、廠房及設備", "6,355,416", "6,084,377"],
  ["其他非流動資產", "646,219", "494,815"],
  ["非流動資產合計", "7,001,635", "6,579,192"],
  ["資產總計", "9,891,656", "9,549,756"],
  ["流動負債"],
  ["短期借款", "300,000", "50,000"],
  ["其他流動負債", "2,579,037", "2,423,150"],
  ["流動負債合計", "2,879,037", "2,473,150"],
  ["非流動負債"],
  ["長期借款", "518,670", "943,523"],
  ["其他非流動負債", "165,977", "350,134"],
  ["非流動負債合計", "684,647", "1,293,657"],
  ["負債總計", "3,563,684", "3,766,807"],
  ["權益"],
  ["股本", "4,000,000", "4,000,000"],
  ["保留盈餘", "2,327,972", "1,782,949"],
  ["權益總計", "6,327,972", "5,782,949"],
  ["負債及權益總計", "9,891,656", "9,549,756"],
];

const opts = { parse: parseNum, tolerance, numericCols: [1, 2], percentCols: [] };

// 1. 8 個合計列 × 2 欄 = 16 格全部自動比對成功
{
  const r = SmartTotals.evaluate(table, opts);
  assert.strictEqual(r.totalRows.length, 8, "應找到 8 個合計列");
  assert.strictEqual(r.confirmed.length, 16, `應確認 16 格，實際 ${r.confirmed.length}`);
  assert.strictEqual(r.unconfirmed.length, 0, "不應有未確認格");
}

// 2. 合計值被改壞 → 該格進未確認清單
{
  const broken = table.map((row) => row.slice());
  broken[9][1] = "9,000,000";
  const r = SmartTotals.evaluate(broken, opts);
  assert.strictEqual(r.confirmed.length, 15);
  assert.strictEqual(r.unconfirmed.length, 1);
  assert.strictEqual(r.unconfirmed[0].r, 9);
  assert.strictEqual(r.unconfirmed[0].c, 1);
  assert.ok(r.unconfirmed[0].candidates.includes(9891656), "候選值應包含正確合計");
}

// 3. 負數/括號金額也能算
{
  const negative = [
    ["項目", "金額"],
    ["收入", "1,000"],
    ["成本", "(400)"],
    ["合計", "600"],
  ];
  const r = SmartTotals.evaluate(negative, {
    parse: parseNum, tolerance, numericCols: [1],
  });
  assert.strictEqual(r.confirmed.length, 1, "1,000 + (-400) = 600 應符合");
}

// 4. 合計標籤判斷
{
  assert.ok(SmartTotals.isTotalLabel("流動資產合計"));
  assert.ok(SmartTotals.isTotalLabel("負債及權益總計"));
  assert.ok(SmartTotals.isTotalLabel("流動資產合計（註1）"));
  assert.ok(SmartTotals.isTotalLabel("資產線計"), "OCR 混淆：總→線");
  assert.ok(SmartTotals.isTotalLabel("負債及權益線計"));
  assert.ok(SmartTotals.isTotalLabel("資產 總計"), "字間空白應可忽略");
  assert.ok(SmartTotals.isTotalLabel("Total assets"));
  assert.ok(!SmartTotals.isTotalLabel("合計金額"), "合計金額是欄位名稱，不是合計列");
  assert.ok(!SmartTotals.isTotalLabel("股東權益總額 分配前"), "分配前/後不是簡單合計");
  assert.ok(!SmartTotals.isTotalLabel("現金及約當現金"));
}

console.log("PASS  smart totals：16 格自動比對、錯誤偵測、負數、標籤判斷");
