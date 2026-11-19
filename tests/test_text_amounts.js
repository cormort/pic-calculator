/* 文字金額模式、貼上表格解析與 CSV 公式注入防護的單元測試。
 * 執行：node tests/test_text_amounts.js
 */
const assert = require("assert");
const { csvSafeCell } = require("../pic-calculator/static/validator.js");
const { parsePastedTable } = require("../pic-calculator/static/table_builder.js");
const {
  wordsToText,
  chineseMoneyParts,
  extractAmounts,
  replaceTextSpan,
  zhMoney,
} = require("../pic-calculator/static/text_amounts.js");

// 1) chineseMoneyParts：複合單位（「5千萬」等）與異常小數點
assert.strictEqual(chineseMoneyParts("5千萬"), 50000000);
assert.strictEqual(chineseMoneyParts("3百萬"), 3000000);
assert.strictEqual(chineseMoneyParts("1千2百萬"), 12000000);
assert.strictEqual(chineseMoneyParts("2百億"), 20000000000);
assert.strictEqual(chineseMoneyParts("1.5千萬"), 15000000);
assert.strictEqual(chineseMoneyParts("0.125億"), 12500000);
assert.strictEqual(chineseMoneyParts("1億2,345萬6千"), 123456000);
assert.strictEqual(chineseMoneyParts("100萬3,000"), 1003000);
assert.ok(isNaN(chineseMoneyParts("50.2.3")), "不合法多小數點應回 NaN");
assert.ok(isNaN(chineseMoneyParts("萬")), "無數字僅單位應回 NaN");

// 2) wordsToText：修千分位點（5.431萬 → 5,431萬），不動 0.125億元 與 1.22%
const w = (text, x1, x2, cy, h = 20) => ({ text, x1, x2, cy, h });
assert.strictEqual(
  wordsToText([
    w("經費5.431萬", 10, 100, 50),
    w("元，較去年", 105, 190, 50),
    w("0.125億元減少1.22%。", 10, 200, 90),
  ]),
  "經費5,431萬元，較去年0.125億元減少1.22%。"
);

// 3) extractAmounts：排除非貨幣「元」（元年／單元／元月），支援國字大寫，保留精準位移
const sample = "審核意見：補助5千萬元，另3百萬元；補助50萬元，再補助50萬元；2024元年，3單元，元月，補助伍拾萬元，0.125億元。";
const items = extractAmounts(sample);
assert.deepStrictEqual(
  items.map((x) => x.value),
  [50000000, 3000000, 500000, 500000, 500000, 12500000]
);
for (const it of items) {
  assert.strictEqual(sample.slice(it.start, it.end), it.text, "位移必須對應原字串");
}
assert.strictEqual(items.length, 6, "非貨幣元不可額外拆出項目");
assert.deepStrictEqual(extractAmounts("2024元年，3單元，元月。"), [], "純非貨幣元段落應回傳空陣列");

// 4) replaceTextSpan：編輯重複文字第 2 筆不影響第 1 筆，且不受 $& / $' 特殊字元影響
const dupSrc = "補助50萬元，再補助50萬元";
const dupItems = extractAmounts(dupSrc);
assert.strictEqual(dupItems.length, 2);
assert.strictEqual(replaceTextSpan(dupSrc, dupItems[1], "再補助60萬元"), "補助50萬元，再補助60萬元");
assert.strictEqual(replaceTextSpan(dupSrc, dupItems[1], "改$&萬元"), "補助50萬元，改$&萬元");

// zhMoney 驗證
assert.strictEqual(zhMoney(50000000), "5,000萬元");
assert.strictEqual(zhMoney(-12000), "短絀1萬2千元");
assert.strictEqual(zhMoney(-12345), "短絀1萬2,345元");

// 5) parsePastedTable 四種格式
assert.deepStrictEqual(
  parsePastedTable("科目\t金額\n人事費\t548,000\n合計\t548,000"),
  [["科目", "金額"], ["人事費", "548,000"], ["合計", "548,000"]]
);
assert.deepStrictEqual(
  parsePastedTable('"科目,備註",金額\n租金,"12,000"'),
  [["科目,備註", "金額"], ["租金", "12,000"]]
);
assert.deepStrictEqual(
  parsePastedTable("科目    金額\n水電    3,500"),
  [["科目", "金額"], ["水電", "3,500"]]
);
assert.deepStrictEqual(
  parsePastedTable("租金 12,000\n水電：3,500"),
  [["租金", "12,000"], ["水電", "3,500"]]
);

// 6) csvSafeCell：擋 Excel 公式注入，但保留負數與一般破折號
assert.strictEqual(csvSafeCell("=SUM(A1)"), "'=SUM(A1)");
assert.strictEqual(csvSafeCell("@CMD"), "'@CMD");
assert.strictEqual(csvSafeCell("+A1+B1"), "'+A1+B1");
assert.strictEqual(csvSafeCell("-A1+B1"), "'-A1+B1");
assert.strictEqual(csvSafeCell("-1,000"), '"-1,000"');
assert.strictEqual(csvSafeCell("-"), "-");
assert.strictEqual(csvSafeCell('a,"b"'), '"a,""b"""');

console.log("PASS  文字金額模式、貼上解析與 CSV 安全");
