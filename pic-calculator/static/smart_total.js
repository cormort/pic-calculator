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
  const QTY_HEAD = /^數量|^單位數量|^件數|^次數|^人[數次]|^時數|^qty|^quantity/i;
  const AMT_HEAD = /^(金額|實付金額|總價|複價|價金|amount|totalamount)/i;

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
    const ended = rows.length > 0 && /(總計|合計)$/.test(rows[rows.length - 1].label.replace(/\s+/g, ""));
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
          // 子項一路到頁尾：下一頁可能還有。但最後一列是「總計」就表示這張表到此結束，對不上就是錯
          else if (j >= rows.length && !ended) unverifiable.push(hit);
          else unconfirmed.push(hit);
        }
        continue;
      }
      // H3 總計列（資產總計、負債及淨值總計）＝上一個總計列之後、最上層各科目的加總
      if (/(總計|合計)$/.test(p.label.replace(/\s+/g, "")) && j === i + 1) {
        let from = i - 1;
        while (from >= 0 && !/(總計|合計)$/.test(rows[from].label.replace(/\s+/g, ""))) from--;
        const above = rows.slice(from + 1, i);
        if (above.length >= 2) {
          const minX = Math.min(...above.map((k) => k.x));
          const tops = above.filter((k) => k.x <= minX + eps);
          for (const c of cols) {
            if (p.vals[c] == null || !tops.some((k) => k.vals[c] != null)) continue;
            const sum = tops.reduce((t, k) => t + (k.vals[c] || 0), 0);
            const hit = { r: p.r, c, label: p.label, actual: p.vals[c], candidates: [sum] };
            // 對不上時不下結論：這一頁可能只是續頁，最上層科目在別頁（單看這頁無從分辨）
            (Math.abs(p.vals[c] - sum) <= tol ? confirmed : unverifiable).push(hit);
          }
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

  /* ---- 跨頁：同一份文件哪幾頁是同一張表往下接 ----
     pages：依頁序的 [{ table, indents, labelCol }]。回傳 [[頁索引…], …]，每一串是一張接續的表。
     規則（實測 59 份平衡表都是「單數頁資產、雙數頁負債」交錯接續，收支表則是單純往下接）：
       - 這一頁第一列是全文件最淺的縮排（資產／負債／業務收入）→ 新的一張表
       - 否則接到「還沒驗完」的表上（有上層科目的子項排到頁尾）；有好幾張沒驗完時，
         接到最久沒被接過的那一張（左右對開的兩張表輪流出現）
       - 沒有科目欄、或欄數／科目欄位置不同的頁不接 */
  function pageStreams(pages, opts) {
    const eps = opts.indentTol ?? 3;
    // 每頁第一個與最後一個「有科目、有數字」的列的縮排；沒有科目欄的頁是 null
    const ends = pages.map((pg) => {
      if (!hierarchy(pg.table, pg.indents, { ...opts, labelCol: pg.labelCol, headerRows: 0 })) return null;
      const xs = [];
      for (let r = 0; r < pg.table.length; r++) {
        const row = pg.table[r] || [];
        if (String(row[pg.labelCol] ?? "").trim() && pg.indents[r] != null
          && row.some((t, c) => c !== pg.labelCol && (/^[-－–—]$/.test(String(t ?? "").trim()) || !isNaN(opts.parse(t))))) {
          xs.push(pg.indents[r]);
        }
      }
      return xs.length ? { first: xs[0], last: xs[xs.length - 1] } : null;
    });
    const top = Math.min(...ends.filter(Boolean).map((e) => e.first));
    const width = (pg) => Math.max(0, ...pg.table.map((r) => (r || []).length));
    const streams = [];
    let tick = 0;
    pages.forEach((pg, i) => {
      const e = ends[i];
      if (!e) { streams.push({ pages: [i], open: false }); return; }
      let s = null;
      if (e.first > top + eps) {
        // 接得上：那張表還有沒驗完的上層科目，或它的最後一列正是這一頁第一列的上層
        s = streams.filter((x) => x.labelCol === pg.labelCol && x.width === width(pg)
          && (x.open || e.first > x.last + eps))
          .sort((a, b) => a.t - b.t)[0] || null;
      }
      if (!s) { s = { pages: [], table: [], indents: [], labelCol: pg.labelCol, width: width(pg) }; streams.push(s); }
      s.pages.push(i);
      s.table.push(...pg.table);
      s.indents.push(...pg.indents);
      s.t = ++tick;
      s.last = e.last;
      const h = hierarchy(s.table, s.indents, { ...opts, labelCol: s.labelCol, headerRows: 0 });
      s.open = !!h && h.unverifiable.length > 0;
    });
    return streams.map((x) => x.pages);
  }

  /* ---- 核銷憑證：發票、收據、領據、印領清冊、黏存單常見的金額關係 ----
     只在「標籤認得出來、數字也讀得到」時才驗，認不出來就不出聲（不猜）。
       稅額：銷售額 + 營業稅 = 總計；營業稅 = 銷售額 × 5%（稅額為 0 視為免稅／零稅率，不驗稅率）
       大寫：新臺幣壹萬貳仟…元整 要等於總計／實領／合計
       實領：應領 − 代扣所得稅 − 補充保費 = 實領（領據是一格一格的；印領清冊是一欄一欄的）
       分批付款：應付總額 − 已付 − 本次付款 = 未付（政府支出憑證處理要點第 13 點，格式二）
       外幣：外幣金額 × 折合率 = 新臺幣金額（同要點第 18 點）
     大寫對應的是要點第 17 點「支出憑證之總數應用大寫數字書寫」。
     ponytail: 格式依公開的統一發票／領據樣式與上述要點整理，沒有拿真實憑證量過；
     遇到認不出的寫法再加標籤，不要放寬成模糊比對。 */
  const CN_DIGIT = { 零: 0, 〇: 0, 壹: 1, 一: 1, 貳: 2, 贰: 2, 二: 2, 兩: 2, 參: 3, 叁: 3, 叄: 3, 三: 3, 肆: 4, 四: 4,
    伍: 5, 五: 5, 陸: 6, 六: 6, 柒: 7, 七: 7, 捌: 8, 八: 8, 玖: 9, 九: 9 };
  const CN_UNIT = { 拾: 10, 十: 10, 佰: 100, 百: 100, 仟: 1000, 千: 1000 };
  const CN_CHARS = "零〇壹一貳贰二兩參叁叄三肆四伍五陸六柒七捌八玖九拾十佰百仟千萬億";

  // 「壹萬貳仟參佰元」「零仟零佰壹拾貳萬參仟肆佰伍拾陸」→ 數字；有認不得的字回傳 NaN
  function chineseAmount(text) {
    const t = String(text ?? "").replace(/[\s,，]/g, "");
    if (!t) return NaN;
    let total = 0, section = 0, digit = 0, seen = false;
    for (const ch of t) {
      if (ch in CN_DIGIT) { digit = CN_DIGIT[ch]; seen = true; }
      else if (ch in CN_UNIT) { section += (digit || (seen ? 0 : 1)) * CN_UNIT[ch]; if (!seen) section = CN_UNIT[ch]; digit = 0; seen = true; }
      else if (ch === "萬") { total += (section + digit) * 1e4; section = 0; digit = 0; seen = true; }
      else if (ch === "億") { total += (section + digit) * 1e8; section = 0; digit = 0; seen = true; }
      else return NaN;
    }
    return seen ? total + section + digit : NaN;
  }

  function voucherChecks(table, opts) {
    const parse = opts.parse;
    const clean = (t) => String(t ?? "").replace(/[\s:：()（）*＊]/g, "");
    // 找「標籤格」右邊同一列的第一個數字（或同一格裡標籤後面的數字）
    const find = (re) => {
      for (let r = 0; r < table.length; r++) {
        const row = table[r] || [];
        for (let c = 0; c < row.length; c++) {
          const m = re.exec(clean(row[c]));
          if (!m) continue;
          // 標籤後面可以再帶幾個字與「$」（「扣繳稅額：$1,000」「實領金額：$8,789」）
          const rest = clean(row[c]).slice(m.index + m[0].length);
          const tail = rest.replace(/^[^\d\-]{0,6}/, "");
          if (tail && !isNaN(parse(tail))) return { r, c, v: parse(tail) };
          if (/\d/.test(rest)) continue;
          for (let k = c + 1; k < row.length; k++) {
            const v = parse(row[k]);
            if (!isNaN(v)) return { r, c: k, v };
          }
        }
      }
      return null;
    };
    const checks = [];
    const add = (kind, cell, expected, text) => checks.push({
      kind, r: cell.r, c: cell.c, actual: cell.v, expected, ok: Math.abs(cell.v - expected) <= 1, text });

    // 稅額
    const sales = find(/^(銷售額合計|銷售額|未稅金額|未稅|合計|小計)/);
    const tax = find(/^(營業稅額|營業稅|稅額|稅金)/);
    const total = find(/^(總計|含稅總計|含稅金額|總額|應付總額)/);
    let invTotal = total;   // 大寫金額要比的總計
    if (sales && tax && total && sales.r !== total.r) {
      add("tax-sum", total, sales.v + tax.v, "銷售額 + 營業稅 = 總計");
      if (tax.v > 0) add("tax-rate", tax, Math.round(sales.v * 0.05), "營業稅 = 銷售額 × 5%");
    } else {
      // 拍照的三聯式發票：標籤是「銷 售 額 合 計」「總　　計」這種拉開的字，OCR 常只剩「售｜合｜計」
      // 「德｜計」，或整列黏成一格（「營業稅4零稅率免稅 27」，勾選的 ✓ 被讀成 4）。
      // 「營業稅」三個字最常讀得出來（實測 9 張範例圖：3 張三聯式都讀到，其中一張是「營案稅」），
      // 所以拿它當錨：稅額那一列的上一個有數字的列是銷售額、下一個是總計。
      // 每列可能有好幾個數字（雜訊），挑「銷售額 + 稅 = 總計」成立的那一組；
      // 沒有任何一組成立時，只有三列都剛好一個數字（沒得挑）才報不符，否則不下結論
      const tokens = (r) => {
        const out = [];
        (table[r] || []).forEach((cell, c) => {
          for (const m of String(cell ?? "").matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
            const v = parseFloat(m[0].replace(/,/g, ""));
            if (Number.isFinite(v)) out.push({ r, c, v });
          }
        });
        return out;
      };
      const rowText = (r) => (table[r] || []).map(clean).join("");
      const tr = table.findIndex((row, r) => /營.稅/.test(rowText(r)) && tokens(r).length);
      if (tr > 0) {
        let sr = -1, cr = -1;
        for (let r = tr - 1; r >= Math.max(0, tr - 3) && sr < 0; r--) if (tokens(r).length) sr = r;
        for (let r = tr + 1; r <= Math.min(table.length - 1, tr + 3) && cr < 0; r++) if (tokens(r).length) cr = r;
        if (sr >= 0 && cr >= 0) {
          const S = tokens(sr), T = tokens(tr), C = tokens(cr);
          let pick = null;
          for (const a of S) for (const b of T) for (const c of C) {
            if (!pick && a.v > 0 && Math.abs(a.v + b.v - c.v) <= 1 && Math.abs(b.v - Math.round(a.v * 0.05)) <= 1) pick = [a, b, c];
          }
          if (!pick && S.length === 1 && T.length === 1 && C.length === 1) pick = [S[0], T[0], C[0]];
          if (pick) {
            const [a, b, c] = pick;
            add("tax-sum", c, a.v + b.v, "銷售額 + 營業稅 = 總計");
            if (b.v > 0) add("tax-rate", b, Math.round(a.v * 0.05), "營業稅 = 銷售額 × 5%");
            invTotal = c;
          }
        }
      }
    }

    // 大寫金額先找出來：整列的字接起來找（常被切成好幾格）。
    // 表單上預印「拾 萬 仟 佰 拾 元整」讓人填空，最前面沒填的單位要去掉（「拾壹萬…」其實是壹萬）
    const capRe = new RegExp(`[${CN_CHARS}]{2,}(?=[元圓整])`);
    let capital = null;
    for (let r = 0; r < table.length && !capital; r++) {
      const text = (table[r] || []).map(clean).join("");
      const m = capRe.exec(text);
      if (!m) continue;
      const vals = [chineseAmount(m[0].replace(/^[拾佰仟萬億十百千]+/, "")), chineseAmount(m[0])].filter((v) => !isNaN(v));
      // fuzzy：大寫那一段夾著認不得的字（「管佰麗零伍佰零零元」「萬千抄百拾元」）＝ OCR 沒讀乾淨。
      // 實測 9 張範例發票圖，大寫有 2 張讀成這樣，照著解析會得到 500、100 而誤報，
      // 所以讀不乾淨時只認「相符」，對不上不下結論
      const zone = text.slice(text.search(new RegExp(`[${CN_CHARS}]`)), m.index + m[0].length)
        .replace(/新臺幣|新台幣|大寫|中文|總計|合計/g, "");
      const fuzzy = new RegExp(`[^${CN_CHARS}]`).test(zone);
      if (vals.length) capital = { r, vals, fuzzy, gross: /應領|應發|支領/.test(text) };
    }

    // 實領（一格一格）
    const GROSS = /^(應領|應發|應付|支領|給付)(金額|總額)?$/, NET = /^(實領|實發|實付|淨領)(金額|數)?$/;
    const WITHHOLD = /(所得稅|代扣稅|扣繳稅)/, NHI = /(補充保險?費|二代健保|健保費)/;
    let gross = find(new RegExp(GROSS.source.replace("$", "")));
    const net = find(new RegExp(NET.source.replace("$", "")));
    // 臺大領款收據的「應領金額」只寫大寫、沒有數字：拿大寫當應領
    let capIsGross = false;
    if (!gross && capital && capital.gross) { gross = { r: capital.r, c: 0, v: capital.vals[0] }; capIsGross = true; }
    const wh = find(WITHHOLD), nhi = find(NHI);
    if (gross && net && (wh || nhi) && gross.r + "," + gross.c !== net.r + "," + net.c) {
      add("net", net, gross.v - (wh ? wh.v : 0) - (nhi ? nhi.v : 0), "應領 − 代扣所得稅 − 補充保費 = 實領");
    } else {
      // 實領（印領清冊：表頭一欄一欄，每人一列）
      for (let hr = 0; hr < Math.min(table.length, 4); hr++) {
        const head = (table[hr] || []).map(clean);
        const col = (re) => head.findIndex((h) => re.test(h));
        const g = col(GROSS), n = col(NET), w = col(WITHHOLD), h2 = col(NHI);
        if (g < 0 || n < 0 || (w < 0 && h2 < 0)) continue;
        for (let r = hr + 1; r < table.length; r++) {
          const gv = parse(table[r]?.[g]), nv = parse(table[r]?.[n]);
          if (isNaN(gv) || isNaN(nv)) continue;
          const sub = (c) => (c < 0 || isNaN(parse(table[r]?.[c])) ? 0 : parse(table[r][c]));
          add("net", { r, c: n, v: nv }, gv - sub(w) - sub(h2), "應領 − 代扣所得稅 − 補充保費 = 實領");
        }
        break;
      }
    }

    // 分批（期）付款表（要點格式二）：應付總額｜截至上次已付金額｜本次付款金額｜已付金額｜未付金額
    //   已付金額 = 截至上次已付金額 + 本次付款金額；未付金額 = 應付總額 − 已付金額
    // 沒有「截至上次」那一欄的簡化表，「已付」含不含本次都有人寫，兩種算法有一種對就算相符
    const due = find(/^(應付總額|契約總價|契約金額|總價)/), paid = find(/^(已付金額|已付款|已付|累計已付)/);
    const unpaid = find(/^(未付金額|未付款|未付|尚未付款)/), now = find(/^(本次付款金額|本次付款|本期付款|本次請款)/);
    const prev = find(/^(截至上次已付金額|截至上次已付|截至上期已付|上次已付)/);
    if (prev && now && paid) add("installment-paid", paid, prev.v + now.v, "截至上次已付 + 本次付款 = 已付金額");
    if (due && paid && unpaid) {
      const a = due.v - paid.v, b = a - (now ? now.v : 0);
      add("installment", unpaid, prev || Math.abs(unpaid.v - a) <= 1 ? a : b, "應付總額 − 已付金額 = 未付金額");
    }

    // 支出科目／機關分攤表（要點格式三、四）：表頭的「總金額」= 分攤金額「合計」
    const whole = find(/^總金額/), shareSum = find(/^合計/);
    if (whole && shareSum && whole.r !== shareSum.r && !tax) add("share", shareSum, whole.v, "分攤金額合計 = 總金額");

    // 外幣折合
    const fx = find(/^(外幣金額|原幣金額|外幣)/), rate = find(/^(折合率|匯率|兌換率)/);
    const ntd = find(/^(折合新臺幣|折合臺幣|新臺幣金額|臺幣金額)/);
    if (fx && rate && ntd) add("fx", ntd, Math.round(fx.v * rate.v), "外幣金額 × 折合率 = 新臺幣金額");

    // 出差旅費報告表：每一列「交通費 + 住宿費 + 雜費 … = 總計」。
    // 表頭常是兩三列合併格，欄位認不準，所以要這張表至少有兩列真的符合這個關係才算數，
    // 符合的列比不符合的多，才把不符合的列標出來
    for (let hr = 0; hr < Math.min(table.length, 4); hr++) {
      const tc = (table[hr] || []).findIndex((h) => /^(總計|合計|小計)$/.test(clean(h)));
      if (tc < 1) continue;
      const headOf = (c) => table.slice(0, hr + 2).map((row) => clean(row?.[c])).join("");
      const cols = [];
      for (let c = 0; c < tc; c++) if (/[費機車鐵船宿雜]|捷運/.test(headOf(c)) && !/[號日月年]|數量|單價/.test(headOf(c))) cols.push(c);
      if (cols.length < 2) break;
      const rowsHit = [];
      for (let r = hr + 1; r < table.length; r++) {
        const tv = parse(table[r]?.[tc]);
        const parts = cols.map((c) => parse(table[r]?.[c])).filter((v) => !isNaN(v));
        if (isNaN(tv) || !parts.length) continue;
        rowsHit.push({ r, c: tc, v: tv, sum: parts.reduce((a, b) => a + b, 0) });
      }
      const good = rowsHit.filter((x) => Math.abs(x.v - x.sum) <= 1).length;
      if (good >= 2 && good >= rowsHit.length - good) {
        for (const x of rowsHit) add("row-sum", x, x.sum, "各項費用加總 = 總計");
      }
      break;
    }

    // 出差旅費報告表（直式，臺大與多數機關的格式）：費用項目一列一列、每天一欄，
    // 「總計」列 = 上面各費用列加總。月、日、單據號數也是數字，不能加進去 ——
    // 一般的合計驗算會把單據號數一起加而誤報，所以這幾列交給這裡驗（ownRows）
    const ownRows = [];
    const labelOf = (row) => {
      let t = "";
      for (const cell of row || []) { if (!isNaN(parse(cell)) && String(cell ?? "").trim()) break; t += clean(cell); }
      return t;
    };
    const labels = table.map(labelOf);
    const docRow = labels.findIndex((t) => /^單據號數/.test(t));
    const sumRow = labels.findIndex((t) => /^總計/.test(t));
    if (docRow >= 0 && sumRow >= 0) {
      const EXPENSE = /費|飛機|高鐵|火車|汽車|機車|捷運|船舶|自行車|陸運/;
      const spend = [];
      for (let r = 0; r < sumRow; r++) if (r !== docRow && EXPENSE.test(labels[r]) && !/^(月|日|起訖|工作|單據|總計)/.test(labels[r])) spend.push(r);
      const width = Math.max(0, ...table.map((row) => (row || []).length));
      if (spend.length >= 2) {
        for (let c = 0; c < width; c++) {
          const tv = parse(table[sumRow]?.[c]);
          const parts = spend.map((r) => parse(table[r]?.[c])).filter((v) => !isNaN(v));
          if (isNaN(tv) || !parts.length) continue;
          add("col-sum", { r: sumRow, c, v: tv }, parts.reduce((x, y) => x + y, 0), "各項費用加總 = 總計");
        }
        ownRows.push(sumRow);
      }
    }

    // 大寫金額 = 數字金額。大寫寫的是哪個數各家不同：臺大領款收據寫應領金額，發票寫總計。
    // 先看同一列的數字，再看總計／應領／實領，有一個相符就算對
    if (capital && !capIsGross) {
      const r = capital.r;
      let same = null;
      for (let c = 0; c < (table[r] || []).length && !same; c++) {
        const v = parse(table[r][c]);
        if (!isNaN(v)) same = { r, c, v };
      }
      const cands = [same, invTotal, gross, net,
        find(/^(實收數額|實收金額|實領|實付|合計|總額|金額合計|核銷金額)/)].filter(Boolean);
      const match = (x) => capital.vals.find((v) => Math.abs(x.v - v) <= 1);
      const hit = cands.find((x) => match(x) !== undefined) || (capital.fuzzy ? null : cands[0]);
      if (hit) add("capital", hit, match(hit) ?? capital.vals[0], "大寫金額 = 數字金額");
    }
    return { checks, failed: checks.filter((x) => !x.ok), checked: checks.length, ownRows };
  }

  const api = { isTotalLabel, rowLabel, candidateTotals, evaluate, findMultiplyCols, multiplyCheck, hierarchy, pageStreams,
    chineseAmount, voucherChecks };
  root.SmartTotals = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
