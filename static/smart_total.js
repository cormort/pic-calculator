/* 智慧合計：自動找出「合計/小計/總計/總額」列，用幾種常見算法試算並比對。
 * 不修改表格資料，只回傳比對結果；前端據此標記並列出需人工確認的列。
 * 純函式、不碰 DOM，可用 `node tests/test_smart_totals.js` 單獨測試。
 */
(function (root) {
  "use strict";

  const TOTAL_SUFFIX = /(合計|小計|總計|總額)$/;
  const TOTAL_PREFIX = /^(grand\s+total|total|subtotal)\b/i;

  function isTotalLabel(label) {
    const text = String(label ?? "")
      .replace(/[（(][^（()）]*[)）]\s*$/, "")
      .replace(/[\s:：*]+$/g, "")
      .trim();
    return TOTAL_SUFFIX.test(text) || TOTAL_PREFIX.test(text);
  }

  function rowLabel(row, parse) {
    for (const cell of row || []) {
      const text = String(cell ?? "").trim();
      if (text && isNaN(parse(text))) return text;
    }
    return "";
  }

  /* 對第 r 列第 c 欄的合計，回傳候選試算值（去重、保留順序）：
   *   1. 緊鄰上方、直到上一個合計列/空白列為止的數字和
   *   2. 上方所有非合計列的數字和
   *   3. 上方最近 1~4 個合計列的累加和
   */
  function candidateTotals(table, r, c, totalSet, parse) {
    const values = [];
    const add = (value) => {
      if (!Number.isFinite(value)) return;
      if (!values.some((v) => Math.abs(v - value) < 0.005)) values.push(value);
    };

    let block = 0;
    let hasBlock = false;
    for (let k = r - 1; k >= 0; k--) {
      if (totalSet.has(k)) break;
      const v = parse(table[k]?.[c]);
      if (isNaN(v)) break;
      block += v;
      hasBlock = true;
    }
    if (hasBlock) add(block);

    let all = 0;
    let hasAll = false;
    for (let k = 0; k < r; k++) {
      if (totalSet.has(k)) continue;
      const v = parse(table[k]?.[c]);
      if (!isNaN(v)) {
        all += v;
        hasAll = true;
      }
    }
    if (hasAll) add(all);

    let sumTotals = 0;
    let count = 0;
    for (let k = r - 1; k >= 0 && count < 4; k--) {
      if (!totalSet.has(k)) continue;
      const v = parse(table[k]?.[c]);
      if (isNaN(v)) continue;
      sumTotals += v;
      count += 1;
      add(sumTotals);
    }
    return values;
  }

  function evaluate(table, opts) {
    const parse = opts.parse;
    const tolerance = opts.tolerance || (() => 0);
    const numericCols = opts.numericCols || [];
    const percentCols = opts.percentCols instanceof Set
      ? opts.percentCols
      : new Set(opts.percentCols || []);

    const totalRows = [];
    for (let r = 0; r < table.length; r++) {
      const label = rowLabel(table[r], parse);
      if (label && isTotalLabel(label)) totalRows.push({ r, label });
    }
    const totalSet = new Set(totalRows.map((x) => x.r));

    const confirmed = [];
    const unconfirmed = [];
    for (const { r, label } of totalRows) {
      for (const c of numericCols) {
        if (percentCols.has(c)) continue;
        const actual = parse(table[r]?.[c]);
        if (isNaN(actual)) continue;
        const candidates = candidateTotals(table, r, c, totalSet, parse);
        if (!candidates.length) continue;
        if (candidates.some((v) => Math.abs(v - actual) <= tolerance(actual))) {
          confirmed.push({ r, c, label, actual });
        } else {
          unconfirmed.push({ r, c, label, actual, candidates });
        }
      }
    }
    return { totalRows, confirmed, unconfirmed };
  }

  const api = { isTotalLabel, rowLabel, candidateTotals, evaluate };
  root.SmartTotals = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
