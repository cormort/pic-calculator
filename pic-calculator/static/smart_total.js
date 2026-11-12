/* 智慧合計：自動找出「合計/小計/總計/總額」列，用幾種常見算法試算並比對。
 * 不修改表格資料，只回傳比對結果；前端據此標記並列出需人工確認的列。
 * 純函式、不碰 DOM，可用 `node tests/test_smart_totals.js` 單獨測試。
 */
(function (root) {
  "use strict";

  // 「合計/小計/總計/總額」是通用寫法；損益表常用「本期賸餘」「本期短絀」「營業利益」
  // 「營業損失」當結果列 —— 這些也算合計列，否則整張損益表會變成「找不到合計列」。
  const TOTAL_SUFFIX = /(合計|小計|總計|總額|賸餘|剩餘|結餘|短絀|淨利|淨損|利益|損失)$/;
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
      // 沒有「合計/小計/總計/賸餘/短絀…」這種標籤時，用兩個猜法：
      //   a) 最後一列＝上方連續數字的加總（原本的做法）
      //   b) 最大值那一列＝上方連續數字的加總
      //      （報表沒寫合計、或整欄是負值時，最大的那個數通常就是結果列）
      const check = (c, r, how) => {
        if (r == null || r < 0) return null;
        const actual = parse(table[r]?.[c]);
        if (isNaN(actual)) return null;
        let sum = 0, n = 0;
        for (let k = r - 1; k >= 0; k--) {
          const v = parse(table[k]?.[c]);
          if (isNaN(v)) break;
          sum += v; n++;
        }
        if (n < 2 || Math.abs(sum - actual) > tolerance(actual)) return null;
        return { r, c, label: rowLabel(table[r], parse) || (how === 'max' ? '最大值那一列' : '最後一列'),
          actual, how, expected: sum };
      };

      const lastHits = [];
      for (const c of numericCols) {
        if (percentCols.has(c)) continue;
        let r = table.length - 1;
        while (r >= 0 && isNaN(parse(table[r]?.[c]))) r--;
        const hit = check(c, r, 'last');
        if (hit) lastHits.push(hit);
      }
      const hits = lastHits.length ? lastHits : (() => {
        const maxHits = [];
        for (const c of numericCols) {
          if (percentCols.has(c)) continue;
          // 這一欄的最大值（含負值欄：最大的那個通常就是結果列）
          let rMax = null, best = -Infinity;
          for (let r = 1; r < table.length; r++) {
            const v = parse(table[r]?.[c]);
            if (isNaN(v)) continue;
            if (v > best) { best = v; rMax = r; }
          }
          const hit = check(c, rMax, 'max');
          if (hit) maxHits.push(hit);
        }
        return maxHits;
      })();

      if (hits.length) {
        const rows = [...new Set(hits.map((h) => h.r))].map((r) => ({ r, label: hits.find((h) => h.r === r).label }));
        return { totalRows: rows, confirmed: hits, unconfirmed: [],
          implicit: hits.every((h) => h.how !== 'max') ? 'last' : hits.every((h) => h.how !== 'last') ? 'max' : 'mixed' };
      }
    }
    return { totalRows, confirmed, unconfirmed };
  }

  /* ---- 乘法關係：單價 × 數量 ＝ 金額 ----
   * 明細表、憑證、標案估價單的金額幾乎都是「單價 × 數量」，而 OCR 錯一格時
   * 「加總驗算」往往還是過（錯的是被加數本身），只有乘法關係抓得出來。
   * 只回傳比對結果，不改資料。
   */
  const UNIT_HEAD = /^單價|^價格|^unitprice|^price|^單價元/i;
  const QTY_HEAD = /^數量|^件數|^次數|^人[數次]|^時數|^qty|^quantity/i;
  const AMT_HEAD = /^(金額|總價|價金|amount|totalamount)/i;

  function headText(v) {
    return String(v ?? "").replace(/[\s（）()：:]/g, "");
  }

  /* 表頭可能不只一列（合併儲存格），所以把前 headerRows 列的同一欄串起來比對。
   * 三個角色必須是不同的欄，否則寧可不算（猜錯欄比不驗更糟）。 */
  function findMultiplyCols(table, headerRows) {
    const hdr = Math.max(1, headerRows | 0 || 1);
    const rows = table.slice(0, hdr);
    const ncols = Math.max(0, ...rows.map((r) => (r || []).length));
    const texts = [];
    for (let c = 0; c < ncols; c++) texts.push(rows.map((r) => headText(r?.[c])).join(""));
    const pick = (re, taken) => texts.findIndex((t, i) => t && !taken.includes(i) && re.test(t));
    const unit = pick(UNIT_HEAD, []);
    const qty = pick(QTY_HEAD, [unit]);
    const amount = pick(AMT_HEAD, [unit, qty]);
    return unit >= 0 && qty >= 0 && amount >= 0 ? { unit, qty, amount } : null;
  }

  function multiplyCheck(table, opts) {
    const parse = opts.parse;
    const tolerance = opts.tolerance || (() => 0);
    const headerRows = Math.max(1, opts.headerRows | 0 || 1);
    const totalSet = new Set(opts.totalRows || []);
    const cols = findMultiplyCols(table, headerRows);
    if (!cols) return null;

    const round2 = (v) => Math.round(v * 100) / 100;
    const confirmed = [];
    const failed = [];
    for (let r = headerRows; r < table.length; r++) {
      if (totalSet.has(r)) continue;                       // 合計列由 evaluate() 負責
      const unit = parse(table[r]?.[cols.unit]);
      const qty = parse(table[r]?.[cols.qty]);
      const actual = parse(table[r]?.[cols.amount]);
      if (isNaN(unit) || isNaN(qty) || isNaN(actual)) continue;   // 空列、文字列
      if (qty === 0 && unit === 0) continue;               // 「－」列不值得驗
      const expected = round2(unit * qty);
      const tol = Math.max(tolerance(actual), 0.005);
      if (Math.abs(expected - actual) <= tol) {
        confirmed.push({ r, unit, qty, actual, expected });
        continue;
      }
      // 反推「哪一格讀錯才會成立」：金額錯（最常見）、單價錯、數量錯各給一個候選
      const fix = { amount: expected };
      if (qty) {
        const u = round2(actual / qty);
        if (u !== unit) fix.unit = u;
      }
      if (unit) {
        const q = round2(actual / unit);
        if (q !== qty) fix.qty = q;
      }
      failed.push({ r, unit, qty, actual, expected, fix });
    }
    return { cols, headerRows, confirmed, failed, checked: confirmed.length + failed.length };
  }

  const api = { isTotalLabel, rowLabel, candidateTotals, evaluate, findMultiplyCols, multiplyCheck };
  root.SmartTotals = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
