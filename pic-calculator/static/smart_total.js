/* 智慧合計：自動找出「合計/小計/總計/總額」列，用幾種常見算法試算並比對。
 * 不修改表格資料，只回傳比對結果；前端據此標記並列出需人工確認的列。
 * 純函式、不碰 DOM，可用 `node tests/test_smart_totals.js` 單獨測試。
 */
(function (root) {
  "use strict";

  const TOTAL_SUFFIX = /(合計|小計|總計|總額)$/;
  const TOTAL_PREFIX = /^(grand\s+total|total|subtotal)\b/i;

  function isTotalLabel(label) {
    const raw = String(label ?? "")
      .replace(/[（(][^（()）]*[)）]\s*$/, "")
      .replace(/[\s:：*]+$/g, "")
      .trim();
    // 前端 tiny 模型常把「總」讀成「線/综/総」；這是報表欄位常見的 OCR 混淆。
    // 中文標籤忽略字間空白；英文前綴仍用原始字串判斷。
    const compact = raw.replace(/\s+/g, "")
      .replace(/(合|小|總|总)计$/, "$1計")
      .replace(/總额$/, "總額")
      .replace(/(?:線|綫|综|総)計$/, "總計");
    return TOTAL_SUFFIX.test(compact) || TOTAL_PREFIX.test(raw);
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
    // 使用者按「是，當合計」確認過的列：標籤被 OCR 截斷（「小計」→「小」）時，
    // 自動判斷會整列漏驗，這時以人工指定為準
    const manual = new Set(opts.extraTotalRows || []);
    for (const r of manual) {
      if (!totalRows.some((t) => t.r === r)) {
        totalRows.push({ r, label: rowLabel(table[r], parse) || `第 ${r + 1} 列`, manual: true });
      }
    }
    totalRows.sort((a, b) => a.r - b.r);
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
    // 沒有合計標籤（例如表頭只寫「總金額」，最後一格就是合計）：
    // 每個數字欄的最後一個數字若等於上方連續數字（至少 2 個）的加總，就當成合計。
    // 只認相符的情況；不相符時無從判斷那格是不是合計，所以不報錯
    if (!totalRows.length) {
      const hits = [];
      for (const c of numericCols) {
        if (percentCols.has(c)) continue;
        let r = table.length - 1;
        while (r >= 0 && isNaN(parse(table[r]?.[c]))) r--;
        let sum = 0, n = 0;
        for (let k = r - 1; k >= 0; k--) {
          const v = parse(table[k]?.[c]);
          if (isNaN(v)) break;
          sum += v; n++;
        }
        const actual = parse(table[r]?.[c]);
        if (n >= 2 && Math.abs(sum - actual) <= tolerance(actual))
          hits.push({ r, c, label: rowLabel(table[r], parse) || "最後一列", actual });
      }
      if (hits.length) {
        const rows = [...new Set(hits.map((h) => h.r))].map((r) => ({ r, label: hits.find((h) => h.r === r).label }));
        return { totalRows: rows, confirmed: hits, unconfirmed: [], implicit: true };
      }
    }
    return { totalRows, confirmed, unconfirmed };
  }

  const api = { isTotalLabel, rowLabel, candidateTotals, evaluate };
  root.SmartTotals = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
