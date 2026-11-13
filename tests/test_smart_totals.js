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
  // 與 index.html 的 Validator._num 一致：夾雜其他符號（"12,345 ]"）就不是數字
  if (!/^[-\d\.,，\(\)\$%％\s]+$/.test(s)) return NaN;
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

// 沒有合計標籤：最後一列等於上方加總 → 視為合計且相符；不相符則不報錯
{
  const t = [["總金額"], ["122,226"], ["2,353"], ["2,765"], ["1,170,285"]];
  t[4] = [String(122226 + 2353 + 2765)];
  const ok = SmartTotals.evaluate(t, { parse: parseNum, tolerance, numericCols: [0] });
  assert.strictEqual(ok.implicit, 'last');   // 值現在是 'last' / 'max' / 'mixed'（哪種猜法）
  assert.strictEqual(ok.confirmed.length, 1);
  assert.strictEqual(ok.confirmed[0].r, 4);
  const bad = SmartTotals.evaluate([["總金額"], ["1"], ["2"], ["99"]], { parse: parseNum, tolerance, numericCols: [0] });
  assert.ok(!bad.implicit);
  assert.strictEqual(bad.unconfirmed.length, 0);
}

// ---- index.html 裡的兩個「提醒用」純函式 ----
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "pic-calculator", "static", "index.html"), "utf8");
const src = [
  html.match(/const TOTALISH = [^\n]*\n/)[0],
  html.match(/const AMOUNT_SHAPE = [^\n]*\n/)[0],
  html.match(/const NO_VALUE = [^\n]*\n/)[0],
  html.match(/function isAmountColumn\(values\) \{[\s\S]*?\n\}/)[0],
  html.match(/function unparsedNumericCells\(table = tableData, headerRows = headerRowCount\(\)\) \{[\s\S]*?\n\}/)[0],
  html.match(/function suspiciousTotalRows\(table = tableData, known = new Set\(\)\) \{[\s\S]*?\n\}/)[0],
].join("\n");
const Validator = { _num: parseNum };
const { unparsedNumericCells, suspiciousTotalRows } = new Function("Validator", "SmartTotals",
  src + "\n; return { unparsedNumericCells, suspiciousTotalRows };")(Validator, SmartTotals);

// 數字欄裡混了看不出是數字的字 → 要抓出來（否則會被靜靜排除在加總外）
const badTable = [
  ["科目", "金額"],
  ["租金", "1,000"],
  ["水電", "12,345 ]"],
  ["修繕", "—"],
  ["雜支", "500"],
];
const bad = unparsedNumericCells(badTable, 1);
assert.strictEqual(bad.length, 1);
assert.deepStrictEqual(bad[0], { r: 2, c: 1, text: "12,345 ]" });

// 文字欄不算數字欄，中文標籤不該被當成壞數字
assert.deepStrictEqual(unparsedNumericCells([["科目", "金額"], ["租金", "1,000"], ["水電", "2,000"]], 1), []);

// 合計標籤被 OCR 截斷（小計 → 小）→ 要主動問使用者
const cutTable = [
  ["科目", "金額"],
  ["租金", "1,000"],
  ["水電", "2,000"],
  ["小", "3,000"],
];
const sus = suspiciousTotalRows(cutTable);
assert.deepStrictEqual(sus, [{ r: 3, label: "小" }]);
// 使用者確認後就不再問
assert.deepStrictEqual(suspiciousTotalRows(cutTable, new Set([3])), []);
// 正常文字列不要亂問
assert.deepStrictEqual(suspiciousTotalRows([["科目", "金額"], ["租金", "1,000"], ["水電", "2,000"]]), []);

// ---- 乘法關係：單價 × 數量 ＝ 金額 ----
const mulTable = [
  ["項次", "會計科目", "單價", "數量", "金額"],
  ["1-1", "主持人費", "25,000", "8", "200,000"],
  ["1-2", "兼任助理", "12,000", "15", "180,000"],
  ["1-3", "臨時工資", "1,400", "120", "168,000"],
  ["小計", "", "", "", "548,000"],
];
const mulOk = SmartTotals.multiplyCheck(mulTable, {
  parse: parseNum, tolerance, headerRows: 1, totalRows: [4],
});
assert.deepStrictEqual(mulOk.cols, { unit: 2, qty: 3, amount: 4 });
assert.strictEqual(mulOk.checked, 3);          // 合計列不算進去
assert.strictEqual(mulOk.confirmed.length, 3);
assert.deepStrictEqual(mulOk.failed, []);

// 金額被讀錯（180,000 → 18,000）：加總可能照樣錯得剛好，只有乘法抓得到
const mulBad = SmartTotals.multiplyCheck(
  [mulTable[0], mulTable[1], ["1-2", "兼任助理", "12,000", "15", "18,000"], mulTable[4]],
  { parse: parseNum, tolerance, headerRows: 1, totalRows: [] },
);
assert.strictEqual(mulBad.failed.length, 1);
assert.strictEqual(mulBad.failed[0].expected, 180000);
assert.strictEqual(mulBad.failed[0].actual, 18000);
assert.strictEqual(mulBad.failed[0].fix.amount, 180000);
assert.strictEqual(mulBad.failed[0].fix.unit, 1200);   // 反推：單價可能是 1,200
assert.strictEqual(mulBad.failed[0].fix.qty, 1.5);     // 或數量是 1.5

// 小數單價（單價 12.5 × 8 = 100）要算得過
const mulFloat = SmartTotals.multiplyCheck(
  [["單價", "數量", "金額"], ["a", "12.5", "8", "100"]].map((r, i) => (i === 0 ? r : r.slice(1))),
  { parse: parseNum, tolerance, headerRows: 1 },
);
assert.strictEqual(mulFloat.checked, 1);
assert.strictEqual(mulFloat.failed.length, 0);

// 缺欄（沒有數量欄）→ 不算，回 null（猜錯欄比不驗更糟）
assert.strictEqual(SmartTotals.multiplyCheck(
  [["科目", "單價", "金額"], ["租金", "1,000", "12,000"]],
  { parse: parseNum, tolerance, headerRows: 1 }), null);

// 表頭有空白與括號也要認得（「單價 (元)」「數 量」）
assert.deepStrictEqual(
  SmartTotals.findMultiplyCols([["科目", "單價 (元)", "數 量", "金額（元）"]], 1),
  { unit: 1, qty: 2, amount: 3 },
);

// 數量 0（贈品列）不該被當成錯誤
const mulZero = SmartTotals.multiplyCheck(
  [["單價", "數量", "金額"], ["贈品", "500", "0", "0"]],
  { parse: parseNum, tolerance, headerRows: 1 },
);
assert.deepStrictEqual(mulZero.failed, []);

// 「填補短絀」是項目不是結果列；逐段累計（上一個合計列＋之後各列）要驗得過
assert.strictEqual(SmartTotals.isTotalLabel("增加基金、公積及填補短絀"), false);
assert.strictEqual(SmartTotals.isTotalLabel("本期短絀"), true);
{
  const cf = [["項目", "金額"], ["本期賸餘(短絀)", "41,317,325"], ["利息股利之調整", "-52,589,978"],
    ["未計利息股利之本期賸餘(短絀)", "-11,272,653"]];
  const r = SmartTotals.evaluate(cf, { parse: parseNum, tolerance, numericCols: [1] });
  assert.ok(r.confirmed.some((h) => h.r === 3) && !r.unconfirmed.length, "逐段累計應相符");
}

// ---- 層級驗算：科目縮排表示上下層（收支餘絀表） ----
{
  const is = [
    ["科目", "本年度", "%", "上年度", "前年度"],
    ["業務收入", "1,000", "100.00", "900", "800"],
    ["勞務收入", "-", "-", "-", "-"],
    ["投融資業務收入", "700", "70.00", "600", "500"],
    ["其他業務收入", "300", "30.00", "300", "300"],
    ["業務成本與費用", "400", "40.00", "350", "300"],
    ["業務費用", "390", "39.00", "341", "290"],
    ["管理及總務費用", "10", "1.00", "9", "10"],
    ["業務賸餘(短絀)", "600", "60.00", "550", "500"],
    ["業務外收入", "50", "5.00", "40", "30"],
    ["業務外費用", "20", "2.00", "10", "-"],
    ["業務外賸餘(短絀)", "30", "3.00", "30", "30"],
    ["本期賸餘(短絀)", "630", "63.00", "580", "530"],
  ];
  const indents = [null, 62, 82, 82, 82, 62, 82, 82, 62, 62, 62, 62, 62];
  const opts = { parse: parseNum, tolerance: 2, labelCol: 0, percentCols: new Set([2]), headerRows: 1 };
  const ok = SmartTotals.hierarchy(is, indents, opts);
  assert.strictEqual(ok.unconfirmed.length, 0, "正確的表不該有不符");
  // 2 個上層 × 3 欄（H1）＋ 3 個結果列 × 3 欄（H2）；百分比欄不驗
  assert.strictEqual(ok.confirmed.length, 15);
  assert.ok(ok.confirmed.every((h) => h.c !== 2), "百分比欄不驗");
  assert.deepStrictEqual(ok.totalRows.map((t) => t.r), [1, 5, 8, 11, 12]);

  // 下層數字錯 → 上層那一格不符，試算值是下層加總
  const badKid = is.map((r) => r.slice());
  badKid[3][1] = "750";
  const r1 = SmartTotals.hierarchy(badKid, indents, opts);
  assert.deepStrictEqual(r1.unconfirmed.map((h) => [h.r, h.c, h.candidates[0]]), [[1, 1, 1050]]);

  // 結果列只有一欄對不上（其他欄都符合「收入−費用」）→ 標那一格
  const badRes = is.map((r) => r.slice());
  badRes[8][3] = "555";
  const r2 = SmartTotals.hierarchy(badRes, indents, opts);
  assert.ok(r2.unconfirmed.some((h) => h.r === 8 && h.c === 3 && h.candidates[0] === 550), "業務賸餘上年度應為 550");

  // 對不上的那一格寫的是「-」（正負號互換時不列增減）：不下結論
  const dash = is.map((r) => r.slice());
  dash[8][3] = "-";
  assert.ok(!SmartTotals.hierarchy(dash, indents, opts).unconfirmed.some((h) => h.r === 8));

  // 子項一路排到頁尾又對不上：可能跨頁，列為無法驗而不是錯
  const cut = is.slice(0, 4);
  const r3 = SmartTotals.hierarchy(cut, indents.slice(0, 4), opts);
  assert.strictEqual(r3.unconfirmed.length, 0);
  assert.strictEqual(r3.unverifiable.length, 3);

  // 沒有科目欄（跨頁寬表的右半）→ 不驗
  const noLabel = is.slice(1).map((r) => r.slice(1));
  assert.strictEqual(SmartTotals.hierarchy(noLabel, indents.slice(1), { ...opts, headerRows: 0 }), null);
}

// ---- 跨頁：哪幾頁是同一張表往下接 ----
{
  const opts = { parse: parseNum, tolerance: 2, percentCols: new Set() };
  const pg = (rows) => ({ table: rows.map((r) => [r[1], r[2]]), indents: rows.map((r) => r[0]), labelCol: 0 });
  // 左右對開的平衡表：1 資產(未完) 2 負債(未完) 3 資產續 4 負債續
  const pages = [
    pg([[10, "資產", "100"], [20, "流動資產", "60"]]),
    pg([[10, "負債", "50"], [20, "流動負債", "30"]]),
    pg([[20, "其他資產", "40"], [30, "什項資產", "40"]]),
    pg([[20, "其他負債", "20"]]),
  ];
  assert.deepStrictEqual(SmartTotals.pageStreams(pages, opts), [[0, 2], [1, 3]]);
  // 接起來之後「資產 = 流動資產 + 其他資產」驗得過
  const joined = [...pages[0].table, ...pages[2].table];
  const h = SmartTotals.hierarchy(joined, [...pages[0].indents, ...pages[2].indents], { ...opts, labelCol: 0 });
  assert.ok(h.confirmed.some((x) => x.label === "資產") && !h.unverifiable.length && !h.unconfirmed.length);
  // 每頁都從最上層開始（各校一頁的寬表）、或前一頁已經驗完：不接
  const same = [pages[0], pg([[10, "資產", "7"], [20, "流動資產", "7"]])];
  assert.deepStrictEqual(SmartTotals.pageStreams(same, opts), [[0], [1]]);
  const done = [pg([[10, "資產", "60"], [20, "流動資產", "60"]]), pg([[20, "其他資產", "40"]])];
  assert.deepStrictEqual(SmartTotals.pageStreams(done, opts), [[0], [1]]);
}

// ---- 核銷憑證 ----
{
  const V = (t) => SmartTotals.voucherChecks(t, { parse: parseNum });
  const kinds = (r) => r.checks.map((c) => c.kind + (c.ok ? "" : "!")).join(",");
  assert.strictEqual(SmartTotals.chineseAmount("壹萬貳仟參佰"), 12300);
  assert.strictEqual(SmartTotals.chineseAmount("零仟零佰壹拾貳萬參仟肆佰伍拾陸"), 123456);
  assert.strictEqual(SmartTotals.chineseAmount("拾"), 10);
  assert.ok(isNaN(SmartTotals.chineseAmount("主持人")));

  // 三聯式發票：合計 + 營業稅 = 總計、稅額 5%、大寫
  const inv = [["品名", "數量", "單價", "金額"], ["碳粉匣", "2", "5,000", "10,000"],
    ["合計", "", "", "10,000"], ["營業稅", "", "", "500"], ["總計", "", "", "10,500"],
    ["總計新臺幣", "壹萬零伍佰", "元整", ""]];
  assert.strictEqual(kinds(V(inv)), "tax-sum,tax-rate,capital");
  const bad = inv.map((r) => r.slice());
  bad[3][3] = "600";   // 稅額寫錯：總計對不上、稅率也不對
  assert.strictEqual(kinds(V(bad)), "tax-sum!,tax-rate!,capital");
  assert.strictEqual(V(bad).failed[1].expected, 500);
  const capBad = inv.map((r) => r.slice());
  capBad[5][1] = "壹萬伍佰伍拾";
  assert.strictEqual(kinds(V(capBad)), "tax-sum,tax-rate,capital!");
  // 免稅：稅額 0 不驗稅率
  assert.strictEqual(kinds(V([["銷售額", "800"], ["營業稅", "0"], ["總計", "800"]])), "tax-sum");

  // 領據（一格一格）與印領清冊（一欄一欄）
  assert.strictEqual(kinds(V([["應領金額", "10,000"], ["代扣所得稅", "1,000"], ["補充保費", "211"], ["實領金額", "8,789"],
    ["新臺幣", "捌仟柒佰捌拾玖元整"]])), "net,capital");
  const roll = [["姓名", "應領金額", "代扣所得稅", "補充保費", "實領金額"],
    ["王小明", "10,000", "1,000", "211", "8,789"], ["李大華", "5,000", "0", "0", "4,000"]];
  assert.strictEqual(kinds(V(roll)), "net,net!");
  assert.deepStrictEqual([V(roll).failed[0].r, V(roll).failed[0].c, V(roll).failed[0].expected], [2, 4, 5000]);

  // 分批付款表：已付含不含本次都接受；外幣折合
  assert.strictEqual(kinds(V([["應付總額", "100,000"], ["已付金額", "30,000"], ["本次付款金額", "20,000"], ["未付金額", "50,000"]])), "installment");
  assert.strictEqual(kinds(V([["應付總額", "100,000"], ["已付金額", "50,000"], ["未付金額", "50,000"]])), "installment");
  assert.strictEqual(kinds(V([["應付總額", "100,000"], ["已付金額", "30,000"], ["未付金額", "60,000"]])), "installment!");
  assert.strictEqual(kinds(V([["外幣金額", "100"], ["折合率", "32.15"], ["折合新臺幣", "3,215"]])), "fx");

  // 出差旅費報告表：每列各項費用加總 = 總計；單據號數不能被加進去
  const trip = [["月", "日", "起訖地點", "交通費", "", "住宿費", "雜費", "總計", "單據號數"],
    ["", "", "", "飛機高鐵", "汽車捷運", "", "", "", ""],
    ["3", "1", "臺北-高雄", "1,490", "60", "2,000", "400", "3,950", "12"],
    ["3", "2", "高雄", "", "80", "2,000", "400", "2,480", "13"],
    ["3", "3", "高雄-臺北", "1,490", "60", "", "200", "1,850", "14"]];
  assert.strictEqual(kinds(V(trip)), "row-sum,row-sum,row-sum!");
  assert.strictEqual(V(trip).failed[0].expected, 1750);

  // ---- 以下照臺大主計室實際表單的欄位（領款收據、分批付款表、分攤表、國內外旅費報告表） ----
  // 領款收據：應領金額只寫大寫（預印「拾 萬 仟 佰 拾 元整」填空）、扣繳稅額：$、扣繳健保費$、實領金額：$
  const ntu = [["應領金額", "新臺幣(大寫) 拾 壹萬 仟 佰 拾 元整"],
    ["扣繳稅額：$1,000", "扣繳健保費$211", "實領金額：$8,789"]];
  assert.strictEqual(kinds(V(ntu)), "net");
  ntu[1][2] = "實領金額：$8,800";
  assert.strictEqual(kinds(V(ntu)), "net!");
  assert.strictEqual(V(ntu).failed[0].expected, 8789);
  // 分批（期）付款表
  const inst = [["應付總額", "100,000"], ["截至上次已付金額", "30,000"], ["本次付款金額", "20,000"],
    ["已付金額", "50,000"], ["未付金額", "50,000"]];
  assert.strictEqual(kinds(V(inst)), "installment-paid,installment");
  inst[3][1] = "60,000";
  assert.strictEqual(kinds(V(inst)), "installment-paid!,installment!");
  // 支出科目分攤表：總金額 = 合計
  assert.strictEqual(kinds(V([["總金額：90,000", "", ""], ["科目", "金額", "說明"], ["業務費", "60,000", ""],
    ["旅運費", "30,000", ""], ["合計", "90,000", ""]])), "share");
  assert.strictEqual(kinds(V([["總金額：90,000", ""], ["甲機關", "60,000"], ["乙機關", "20,000"], ["合計", "80,000"]])), "share!");
  // 國內出差旅費報告表（直式）：月、日、單據號數不能加進總計
  const ntuTrip = [["月", "", "3", "3"], ["日", "", "1", "2"], ["起訖地點", "", "臺北-高雄", "高雄-臺北"],
    ["交通費", "飛機及高鐵", "1,490", "1,490"], ["", "汽車及捷運", "60", "80"], ["住宿費", "", "2,000", ""],
    ["雜費", "", "400", "400"], ["單據號數", "", "12", "13"], ["總計", "", "3,950", "2,000"]];
  assert.strictEqual(kinds(V(ntuTrip)), "col-sum,col-sum!");
  assert.deepStrictEqual([V(ntuTrip).failed[0].expected, V(ntuTrip).ownRows], [1970, [8]]);

  // 一般表格（沒有憑證標籤）不出聲
  assert.strictEqual(V(table).checked, 0);
}

console.log("PASS  smart totals：16 格自動比對、錯誤偵測、負數、標籤判斷、乘法關係（單價×數量）");
