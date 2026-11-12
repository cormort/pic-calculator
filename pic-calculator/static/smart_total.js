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
    // 「增加基金、公積及填補短絀」是現金流量表的一個項目，短絀是被填補的對象，不是結果列
    if (/填補短絀$/.test(compact)) return false;
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
   *   4. 上一個合計列 + 之後各列（逐段累計）
   */
  function candidateTotals(table, r, c, totalSet, parse) {
    const values = [];
    const add = (value) => {
      if (!Number.isFinite(value)) return;
      if (!values.some((v) => Math.abs(v - value) < 0.005)) values.push(value);
    };

    let block = 0;
    let hasBlock = false;
    let carried = NaN;   // 這一段上面緊接的合計列
    for (let k = r - 1; k >= 0; k--) {
      if (totalSet.has(k)) { carried = parse(table[k]?.[c]); break; }
      const v = parse(table[k]?.[c]);
      if (isNaN(v)) break;
      block += v;
      hasBlock = true;
    }
    if (hasBlock) add(block);
    // 4. 逐段累計：上一個合計列 + 之後各列（現金流量表「本期賸餘 + 利息股利之調整
    //    ＝ 未計利息股利之本期賸餘」這種一路往下滾的結構）
    if (hasBlock) add(block + carried);

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

  /* ---- 層級驗算：財務報表的科目用縮排表示上下層 ----
     indents[r]：第 r 列科目文字的左緣位置（只有 PDF 文字層的座標夠準）。
     H1 上層＝下層加總：某列之後縮排更深的連續列是它的子孫，其中最淺的一層是直接子項。
     H2 結果列（賸餘／短絀／餘額…）＝前面同層幾列的加減組合；同一組正負號要在
        所有金額欄都成立才算數，所以不會湊巧對上。
     實測（211 份、427 頁預算書表）：H1 7,216 格相符、0 格誤判；305 格因子項延伸到頁尾
     （跨頁）無法驗，列在 unverifiable，不當成錯。
     沒有科目欄的頁（跨頁寬表的右半）回傳 null。 */
  const HIER_TOTALISH = /淨現金|合計|小計|總計|淨增|淨減/;   // 這些是結果列，不是誰的子項
  const HIER_RESULT = /賸餘|短絀|餘絀|餘額|淨額|淨值/;

  function hierarchy(table, indents, opts) {
    const parse = opts.parse, lc = opts.labelCol, eps = opts.indentTol ?? 3, tol = opts.tolerance ?? 2;
    const skip = opts.percentCols || new Set();
    const isDash = (t) => /^[-－–—]$/.test(String(t ?? "").trim());
    const val = (t) => {
      const s = String(t ?? "").trim();
      if (!s) return null;
      if (isDash(s)) return 0;   // 報表的「-」是零
      const v = parse(s);
      return isNaN(v) ? null : v;
    };
    const rows = [];
    for (let r = opts.headerRows || 0; r < table.length; r++) {
      const label = String(table[r]?.[lc] ?? "").trim();
      const vals = (table[r] || []).map((t, c) => (c === lc ? null : val(t)));
      if (label && indents[r] != null && vals.some((v) => v !== null)) rows.push({ r, label, x: indents[r], vals });
    }
    if (rows.filter((w) => !/^[-\d,.()% ]+$/.test(w.label)).length < rows.length * 0.7) return null;
    const ncols = Math.max(0, ...rows.map((w) => w.vals.length));
    const cols = [];
    for (let c = 0; c < ncols; c++) {
      // 百分比欄不驗：各列四捨五入後加不回 100
      if (c === lc || skip.has(c) || rows.some((w) => w.vals[c] != null && Math.abs(w.vals[c] % 1) > 1e-9)) continue;
      cols.push(c);
    }

    const confirmed = [], unconfirmed = [], unverifiable = [];
    for (let i = 0; i < rows.length; i++) {
      const p = rows[i];
      let j = i + 1;
      while (j < rows.length && rows[j].x > p.x + eps) j++;
      const kids = rows.slice(i + 1, j).filter((k) => !HIER_TOTALISH.test(k.label));
      if (kids.length) {
        // H1
        const minX = Math.min(...kids.map((k) => k.x));
        const direct = kids.filter((k) => k.x <= minX + eps);
        for (const c of cols) {
          if (p.vals[c] == null) continue;
          const ks = direct.filter((k) => k.vals[c] != null);
          if (!ks.length) continue;
          const sum = ks.reduce((t, k) => t + k.vals[c], 0);
          const hit = { r: p.r, c, label: p.label, actual: p.vals[c], candidates: [sum] };
          if (Math.abs(p.vals[c] - sum) <= tol) confirmed.push(hit);
          else if (j >= rows.length) unverifiable.push(hit);   // 子項一路到頁尾：下一頁可能還有
          else unconfirmed.push(hit);
        }
        continue;
      }
      // H2
      if (!HIER_RESULT.test(p.label) || j > i + 1) continue;
      const sib = [];
      for (let k = i - 1; k >= 0 && sib.length < 5; k--) {
        if (Math.abs(rows[k].x - p.x) <= eps) sib.push(rows[k]);
        else if (rows[k].x < p.x - eps) break;
      }
      const cs = cols.filter((c) => p.vals[c] != null);
      if (sib.length < 2 || !cs.length || cs.every((c) => p.vals[c] === 0)) continue;
      let best = null;
      const odd = new Set();
      for (let m = 0; m < 3 ** sib.length; m++) {
        const co = [];
        for (let k = 0, t = m; k < sib.length; k++, t = Math.floor(t / 3)) co.push([0, 1, -1][t % 3]);
        if (co.filter(Boolean).length < 2) continue;
        const exp = (c) => sib.reduce((t, w, k) => t + co[k] * (w.vals[c] || 0), 0);
        const miss = cs.filter((c) => Math.abs(p.vals[c] - exp(c)) > tol);
        if (!miss.length) { best = { miss, exp }; odd.clear(); break; }
        // 只有一欄對不上、其他至少兩個非零欄都對 → 那一格很可能就是錯的
        if (miss.length === 1 && cs.length >= 3 && cs.filter((c) => c !== miss[0] && p.vals[c] !== 0).length >= 2) {
          odd.add(miss[0]);
          best = best || { miss, exp };
        }
      }
      if (!best || odd.size > 1) continue;   // 解釋不了，或可疑的格子不只一種說法：不下結論
      // 對不上的那一格原文是「-」：是刻意不列，不是算錯。實測 8 張收支表的「比較增減」欄，
      // 賸餘與短絀互換（正負號相反）的那一列都寫「-」而不寫差額
      if (best.miss.some((c) => isDash(table[p.r]?.[c]))) continue;
      for (const c of cs) {
        const hit = { r: p.r, c, label: p.label, actual: p.vals[c], candidates: [best.exp(c)] };
        (best.miss.includes(c) ? unconfirmed : confirmed).push(hit);
      }
    }
    const seen = new Map();
    for (const h of [...confirmed, ...unconfirmed, ...unverifiable]) seen.set(h.r, h.label);
    return {
      confirmed, unconfirmed, unverifiable,
      totalRows: [...seen].map(([r, label]) => ({ r, label })).sort((a, b) => a.r - b.r),
    };
  }

  const api = { isTotalLabel, rowLabel, candidateTotals, evaluate, findMultiplyCols, multiplyCheck, hierarchy };
  root.SmartTotals = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
