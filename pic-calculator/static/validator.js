/* 數字整理、表格欄位判斷、手動驗算（Validator）與選取角色狀態。
 * 純函式模組（不碰 DOM），可供瀏覽器與 Node 單元測試共用。
 */
(function (root) {
  "use strict";

  const FULLWIDTH_MAP = {
    '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
    '．': '.', '，': ',', '－': '-', '（': '(', '）': ')', '％': '%', '　': ' ', '＋': '+', '／': '/', '：': ':'
  };
  const MINUS_VARIANTS = /[−–—﹣－‒]/g;
  const CONFUSABLES = {
    'O': '0', 'o': '0', '〇': '0', 'D': '0', 'Q': '0',
    'l': '1', 'I': '1', '|': '1', 'i': '1',
    'S': '5', 's': '5', 'B': '8', 'Z': '2', 'z': '2',
    'G': '6', 'q': '9', 'g': '9', 'T': '7'
  };

  function toHalfWidth(s) {
    return String(s ?? '').replace(/[\uff01-\uff5e　]/g, ch => FULLWIDTH_MAP[ch] || String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  }

  // 「1.920.497」「3,766.807」這種：句點後面剛好三位一組 → 句點其實是千分位
  // 前後可能有括號（會計負數）、負號或幣別符號，只修中間純數字的部分
  function fixThousandDots(s) {
    const t = String(s);
    const pre = /^[-(（$]*/.exec(t)[0], post = /[)）%％]*$/.exec(t.slice(pre.length))[0];
    const core = t.slice(pre.length, t.length - post.length);
    if (!/^\d+[.,\d]*$/.test(core)) return t;
    let fixed = core;
    if (/^\d{1,3}(?:[.,]\d{3}){2,}$/.test(core)) fixed = core.replace(/\./g, ',');
    return pre + fixed + post;
  }

  function getSmartTotals() {
    if (root.SmartTotals) return root.SmartTotals;
    if (typeof require === 'function') {
      try { return require('./smart_total.js'); } catch (e) { return null; }
    }
    return null;
  }

  /* =============================================================
     驗算邏輯 (移植自 excel-validator/js/validator.js)
     ============================================================= */
  const Validator = {
    errors: new Map(),

    validate(opts) {
      this.errors.clear();
      const { mode, sheetData, headerRow, endRow, startCol, endCol,
              selectedIndices, selectedSigns, keywords, sumDirection } = opts;
      const hRowIdx = headerRow - 1;
      const sColIdx = startCol - 1;
      const maxRow = endRow || sheetData.length;
      const maxCol = endCol || (sheetData[hRowIdx]?.length || 0);
      const headers = sheetData[hRowIdx] || [];

      switch (mode) {
        case 'vertical_group':
          this._vGroup({ sheetData, hRowIdx, maxRow, sColIdx, maxCol,
            nameColIndex: selectedIndices[0],
            triggerKeywords: keywords.trigger, excludeKeywords: keywords.exclude,
            sumDirection });
          break;
        case 'horizontal_group':
          this._hGroup({ sheetData, headers, hRowIdx, maxRow, sColIdx, maxCol,
            triggerKeywords: keywords.trigger, excludeKeywords: keywords.exclude });
          break;
        case 'vertical_indent':
          this._vIndent({ sheetData, hRowIdx, maxRow, sColIdx, maxCol,
            nameColIndex: selectedIndices[0] });
          break;
        case 'horizontal':
          this._hManual({ sheetData, hRowIdx, maxRow, selectedIndices, selectedSigns });
          break;
        case 'vertical_row':
          this._vManual({ sheetData, sColIdx, maxCol, selectedIndices, selectedSigns });
          break;
      }
      const all = Array.from(this.errors.values());
      const failed = all.filter(e => !e.ok);
      return {
        errorCount: failed.length,
        errors: this.errors,
        errorList: all,
        totalDiff: failed.reduce((s, e) => s + e.diff, 0),
      };
    },

    _vGroup({ sheetData, hRowIdx, maxRow, sColIdx, maxCol, nameColIndex,
              triggerKeywords, excludeKeywords, sumDirection }) {
      if (nameColIndex == null) return;
      const st = getSmartTotals();
      for (let c = sColIdx; c < maxCol; c++) {
        if (c === nameColIndex) continue;
        let tempSum = 0, pendingCheck = null;
        const prevTotals = [];   // 已驗過的合計值：用來支援「合計＝各小計相加」這種結構
        for (let r = hRowIdx + 1; r < maxRow; r++) {
          const row = sheetData[r];
          if (!row) continue;
          // 合計標籤常被打在項次欄（「小計」「合計」），科目欄是空的 —— 讀不到就用該列
          // 第一個非數字格當名稱，否則自動分組會整張表都找不到合計列
          const name = String(row[nameColIndex] || '').trim()
            || String((st && st.rowLabel(row, this._num)) || '');
          const val = this._num(row[c]);
          const isNum = !isNaN(val);
          const isTrig = triggerKeywords.some(k => name.toLowerCase().includes(k.toLowerCase()));
          const isExcl = excludeKeywords.some(k => name.toLowerCase().includes(k.toLowerCase()));
          if (isExcl) continue;
          if (isTrig) {
            if (sumDirection === 'bottom') {
              if (isNum) {
                // 多數報表的「合計」是「各小計相加」，不是「上一條線之後的加總」——
                // 先試區塊加總，不符再試已驗過合計的累加，兩者皆非才算錯
                const tol = Math.max(1.0, Math.abs(val) * 0.00001);
                let calc = tempSum;
                const alt = prevTotals.reduce((a, b) => a + b, 0);
                if (prevTotals.length && Math.abs(val - calc) > tol && Math.abs(val - alt) <= tol) calc = alt;
                this._check(r, c, calc, val);
                prevTotals.push(val);
              }
              tempSum = 0;
            } else {
              if (pendingCheck !== null) this._check(pendingCheck.row, c, tempSum, pendingCheck.target);
              tempSum = 0;
              pendingCheck = isNum ? { row: r, target: val } : null;
            }
          } else {
            if (isNum) tempSum += val;
          }
        }
        if (sumDirection === 'top' && pendingCheck !== null)
          this._check(pendingCheck.row, c, tempSum, pendingCheck.target);
      }
    },

    _hGroup({ sheetData, headers, hRowIdx, maxRow, sColIdx, maxCol,
              triggerKeywords, excludeKeywords }) {
      for (let r = hRowIdx + 1; r < maxRow; r++) {
        const row = sheetData[r];
        if (!row) continue;
        let tempSum = 0;
        for (let c = sColIdx; c < maxCol; c++) {
          const headerName = String(headers[c] || '');
          const val = this._num(row[c]);
          const isNum = !isNaN(val);
          if (triggerKeywords.some(k => headerName.toLowerCase().includes(k.toLowerCase()))) {
            if (isNum) this._check(r, c, tempSum, val);
            tempSum = 0;
          } else if (!excludeKeywords.some(k => headerName.toLowerCase().includes(k.toLowerCase()))) {
            if (isNum) tempSum += val;
          }
        }
      }
    },

    _vIndent({ sheetData, hRowIdx, maxRow, sColIdx, maxCol, nameColIndex }) {
      if (nameColIndex == null) return;
      const rowLevels = [];
      for (let r = hRowIdx + 1; r < maxRow; r++) {
        const name = sheetData[r] ? String(sheetData[r][nameColIndex] || '') : '';
        rowLevels[r] = this._leadingSpaces(name);
      }
      for (let c = sColIdx; c < maxCol; c++) {
        if (c === nameColIndex) continue;
        for (let r = hRowIdx + 1; r < maxRow - 1; r++) {
          if (rowLevels[r + 1] > rowLevels[r]) {
            const targetLevel = rowLevels[r + 1];
            let childrenSum = 0, hasChild = false;
            for (let k = r + 1; k < maxRow; k++) {
              if (rowLevels[k] <= rowLevels[r]) break;
              if (rowLevels[k] === targetLevel) {
                const v = this._num(sheetData[k]?.[c]);
                if (!isNaN(v)) { childrenSum += v; hasChild = true; }
              }
            }
            if (hasChild) {
              const tv = this._num(sheetData[r]?.[c]);
              if (!isNaN(tv)) this._check(r, c, childrenSum, tv);
            }
          }
        }
      }
    },

    // 加減：任意個數相加。乘除：固定兩個運算元（依點選順序 被乘數×乘數、被除數÷除數），不與加減混用
    _evalManual(inputs, getVal, selectedSigns) {
      const op = inputs.map(i => selectedSigns.get(i)).find(r => r === 2 || r === -2);
      if (op) {
        if (inputs.length !== 2) return null;
        const [a, b] = inputs.map(i => this._num(getVal(i)));
        if (isNaN(a) || isNaN(b)) return null;
        if (op === 2) return a * b;
        return b === 0 ? null : a / b;
      }
      let sum = 0, hasInput = false;
      for (const idx of inputs) {
        const v = this._num(getVal(idx));
        if (!isNaN(v)) { sum += v * (selectedSigns.get(idx) || 1); hasInput = true; }
      }
      return hasInput ? sum : null;
    },

    _hManual({ sheetData, hRowIdx, maxRow, selectedIndices, selectedSigns }) {
      if (selectedIndices.length < 2) return;
      const targetIdx = selectedIndices[selectedIndices.length - 1];
      const inputs = selectedIndices.slice(0, -1);
      const isDiv = inputs.some(i => selectedSigns.get(i) === -2);
      for (let r = hRowIdx + 1; r < maxRow; r++) {
        const row = sheetData[r];
        if (!row) continue;
        const tv = this._num(row[targetIdx]);
        if (isNaN(tv)) continue;
        const calc = this._evalManual(inputs, i => row[i], selectedSigns);
        if (calc !== null) this._check(r, targetIdx, calc, tv, isDiv);
      }
    },

    _vManual({ sheetData, sColIdx, maxCol, selectedIndices, selectedSigns }) {
      if (selectedIndices.length < 2) return;
      const targetIdx = selectedIndices[selectedIndices.length - 1];
      const inputs = selectedIndices.slice(0, -1);
      const isDiv = inputs.some(i => selectedSigns.get(i) === -2);
      for (let c = sColIdx; c < maxCol; c++) {
        const tv = this._num(sheetData[targetIdx]?.[c]);
        if (isNaN(tv)) continue;
        const calc = this._evalManual(inputs, r => sheetData[r]?.[c], selectedSigns);
        if (calc !== null) this._check(targetIdx, c, calc, tv, isDiv);
      }
    },

    _check(row, col, calc, actual, isDiv = false) {
      const tol = isDiv
        ? Math.max(0.01, Math.abs(actual) * 0.001)
        : Math.max(1.0, Math.abs(actual) * 0.00001);
      const diff = actual - calc;
      const key = `${row},${col}`;
      if (Math.abs(diff) > tol) {
        this.errors.set(key, {
          row, col, ok: false, expected: calc, actual, diff,
          message: `第 ${row + 1} 列 / 第 ${col + 1} 欄 — 應為 ${calc.toLocaleString(undefined, { maximumFractionDigits: 2 })}，實際為 ${actual.toLocaleString(undefined, { maximumFractionDigits: 2 })} (差 ${diff >= 0 ? '+' : ''}${diff.toLocaleString(undefined, { maximumFractionDigits: 2 })})`,
        });
      } else {
        this.errors.set(key, { row, col, ok: true });
      }
    },

    hasErr(r, c) {
      const e = this.errors.get(`${r},${c}`);
      return Boolean(e && !e.ok);
    },
    isOk(r, c) {
      const e = this.errors.get(`${r},${c}`);
      return Boolean(e && e.ok);
    },
    errMsg(r, c) {
      const e = this.errors.get(`${r},${c}`);
      return e && !e.ok ? (e.message || null) : null;
    },

    _num(v) {
      if (v === null || v === undefined || v === '') return NaN;
      if (typeof v === 'number') return isNaN(v) ? NaN : v;
      let s = toHalfWidth(v.toString()).trim();
      if (s === '') return NaN;
      // 金額前後常帶幣別（NT$、USD、NTS＝$ 被讀成 S）或手寫打勾被讀成的 V、J、√：
      // 英文字母與 $ 只出現在數字前後、合計不超過 6 個字，中間又是單一個數字時，只取數字。
      // 字母夾在數字中間（Q3 2024、2023 vs 2024）就不算數字。
      s = s.replace(/[√✓✔]/g, ' ').trim();
      // 手寫勾被讀成「1」「|」「I」時會黏在金額前面（例：'1 NTS 2,353'、'| NT$ 20,000'）。
      // 只在「後面接著幣別、幣別後面還有數字」時才丟掉這個前導字 ——
      // 否則「1 件」這種真的以數字開頭的內容會被吃掉
      s = s.replace(/^[1|Iil]\s*(?=[A-Za-z$]{1,4}\s*\d)/, '').trim();
      const money = s.match(/^([A-Za-z$\s]*?)([-(（]?\s*\d[\d,，.]*(?:[,，.]\s+\d[\d,，.]*)*\s*[)）]?\s*[%％]?)\s*([A-Za-z$元]*)$/);
      // 例外：數字後面「緊黏」的全是長得像數字的字母（2OO、1,0l）是辨識錯，不是幣別 ——
      // 當成 2 會讓驗算悄悄算錯；回傳 NaN 才會被標成「不像數字」請人修正
      const misread = money && /\d$/.test(money[2]) && /^[OoQDIl|SsBZzGgqT]+$/.test(money[3]);
      if (money && !misread && (money[1] + money[3]).replace(/\s/g, '').length <= 6) s = money[2];
      s = fixThousandDots(s);
      if (/[a-zA-Z一-龥]/.test(s)) return NaN;
      if (!/^[-\d\.,，\(\)\$%\s]+$/.test(s)) return NaN;
      s = s.replace(/[,，\$\s]/g, '').replace(/[%％]/g, '');
      if (s.startsWith('(') && s.endsWith(')')) s = '-' + s.replace(/[\(\)]/g, '');
      const n = parseFloat(s);
      return isNaN(n) ? NaN : n;
    },

    _leadingSpaces(s) {
      if (!s || typeof s !== 'string') return 0;
      const m = s.match(/^[\s 　]*/);
      return m ? m[0].length : 0;
    },
  };

  /* 逐格整理；需要「這一欄是不是數字欄」的上下文來判斷 25.000 是 25 還是 25,000。 */
  function repairNumericCells(data, confidence, headerRows = 1) {
    const repairs = [];
    const out = data.map(r => r.slice());
    const cols = Math.max(0, ...out.map(r => r.length));
    const parse = v => Validator._num(v);
    const hdr = Math.max(0, headerRows | 0);
    const startRow = out.length - hdr >= 2 ? hdr : 0;
    const numeric = [];
    for (let c = 0; c < cols; c++) {
      let n = 0, total = 0;
      for (let r = startRow; r < out.length; r++) {
        const t = String(out[r]?.[c] ?? '').trim();
        if (!t) continue;
        total++;
        if (!isNaN(parse(t))) n++;
      }
      numeric[c] = total > 0 && n / total >= 0.5;
    }
    const colHasThousands = [];
    for (let c = 0; c < cols; c++) {
      let hasT = false;
      for (let r = startRow; r < out.length; r++) {
        const t = fixThousandDots(toHalfWidth(String(out[r]?.[c] ?? '')).trim());
        if (/(?:^|[-(（])\d{1,3}(?:,\d{3})+(?:[)）]|$)/.test(t)) { hasT = true; break; }
      }
      colHasThousands[c] = hasT;
    }
    for (let r = 0; r < out.length; r++) {
      const row = out[r] || [];
      const rowHasText = row.some(cell => {
        const t = String(cell ?? '').trim();
        return t && isNaN(parse(t));
      });
      const isHeader = r < hdr && out.length > hdr && rowHasText;
      for (let c = 0; c < row.length; c++) {
        const orig = String(row[c] ?? '').trim();
        if (!orig) continue;
        let s = toHalfWidth(orig).replace(MINUS_VARIANTS, '-').trim();
        // 「969,.524」逗號與句點黏在一起：多出來的那一個是雜訊
        s = s.replace(/,\./g, ',').replace(/\.(?=,)/g, '');
        // 數字後面黏著表格線／雜訊（「12,345 ]」「200,000|」）：去掉結尾非數字字元。
        if (isNaN(parse(s))) {
          const trimmed = s.replace(/[\s\]\)\|\}、，。」”'’;:；：!！?？>»]+$/g, '');
          if (trimmed && !isNaN(parse(trimmed))) s = trimmed;
        }
        s = fixThousandDots(s);
        if (!isNaN(parse(s)) && /[A-Za-z]/.test(s) === false) {
          // 只有數字、逗號、點、括號、負號：交給下面統一格式化
        } else if (!isHeader && (numeric[c] || /^[\dOolISBZGsqgT.,()\-\s]+$/.test(s))) {
          // 混淆字只在資料列且為數字欄或有明顯數字骨架時才動手（避免把表頭 I／S 改成 1／5）
          const mapped = s.replace(/[A-Za-z〇|]/g, ch => CONFUSABLES[ch] ?? ch);
          if (mapped !== s && !isNaN(parse(fixThousandDots(mapped)))) s = fixThousandDots(mapped);
        }
        // 單組「25.000」或漏掉第二個逗號的 7 位數（「2.473150」→「2,473,150」）：靠整欄的千分位習慣判斷
        if (colHasThousands[c] && numeric[c]) {
          if (/^([-(（]?)(\d{1,3})\.(\d{3})([)）]?)$/.test(s)) {
            s = s.replace(/^([-(（]?)(\d{1,3})\.(\d{3})([)）]?)$/, '$1$2,$3$4');
          } else if (/^([-(（]?)([1-9]\d{0,2})\.(\d{3})(\d{3})([)）]?)$/.test(s)) {
            s = s.replace(/^([-(（]?)([1-9]\d{0,2})\.(\d{3})(\d{3})([)）]?)$/, '$1$2,$3,$4$5');
          }
        }
        // 統一千分位：能解析的數字重新格式化（-1,234.5），表頭的西元年份 2024 維持原樣
        const n = parse(s);
        if (!isNaN(n) && /^[\d,.\-()%$ ]+$/.test(s)) {
          const body = s.replace(/[,$ ]/g, '');
          if (/^-?\d+(\.\d+)?$/.test(body) && !(isHeader && /^(19|20)\d{2}$/.test(body))) {
            const dec = (body.split('.')[1] || '').length;
            const digits = Math.min(dec, 20);
            s = n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
          }
        }
        if (s !== orig) {
          out[r][c] = s;
          repairs.push({ r, c, from: orig, to: s });
          if (confidence?.[r]) confidence[r][c] = Math.min(confidence[r][c] ?? 1, 0.9);
        }
      }
    }
    return { data: out, repairs };
  }

  /* 數字欄裡「有字但不是數字」的格 */
  const AMOUNT_SHAPE = /^[-(（$]?\d[\d,]*(?:\.\d+)?[)）%]?$/;
  const NO_VALUE = /^[-–—－‐—/]+$/;
  function isAmountColumn(values) {
    const vals = values.map(v => String(v ?? '').trim())
      .filter(v => v && !NO_VALUE.test(v.replace(/\s/g, '')));
    if (vals.length < 2) return false;
    const amounts = vals.filter(v => AMOUNT_SHAPE.test(v.replace(/\s/g, '')) || !isNaN(Validator._num(v)));
    return amounts.length >= 2 && amounts.length / vals.length >= 0.6;
  }

  /* 文字欄的「雜字」剝除 */
  function stripGarbageText(data, headerRows = 1) {
    const out = { data: data.map(r => r.slice()), repairs: [] };
    const cols = Math.max(0, ...data.map(r => r.length));
    const amountCols = new Set();
    for (let c = 0; c < cols; c++) {
      if (isAmountColumn(data.slice(headerRows).map(r => String(r?.[c] ?? '')))) amountCols.add(c);
    }
    for (let r = headerRows; r < out.data.length; r++) {
      const row = out.data[r] || [];
      for (let c = 0; c < row.length; c++) {
        if (amountCols.has(c)) continue;
        const raw = String(row[c] ?? '').trim();
        if (raw.length < 3 || !/[\u4e00-\u9fff]/.test(raw)) continue;
        if (!isNaN(Validator._num(raw))) continue;
        let fixed = null;
        if (/[A-Za-z]$/.test(raw) && /[\u2e80-\u9fff]/.test(raw.slice(0, -1))) fixed = raw.slice(0, -1);
        else if (raw[0] === raw[raw.length - 1]) fixed = raw.slice(0, -1);
        if (!fixed || fixed.length < 2) continue;
        row[c] = fixed;
        out.repairs.push({ r, c, from: raw, to: fixed });
      }
    }
    return out;
  }

  function unparsedNumericCells(table = [], headerRows = 1) {
    const out = [];
    const cols = Math.max(0, ...table.map(r => r.length));
    for (let c = 0; c < cols; c++) {
      const vals = table.slice(headerRows).map(r => String(r?.[c] ?? '').trim());
      if (!isAmountColumn(vals)) continue;
      for (let r = headerRows; r < table.length; r++) {
        const raw = String(table[r]?.[c] ?? '').trim();
        if (!raw) continue;
        if (!isNaN(Validator._num(raw))) continue;
        if (/^[-–—－‐—/]+$/.test(raw)) continue;
        if (!/\d/.test(raw)) continue;
        out.push({ r, c, text: raw });
      }
    }
    return out;
  }

  const TOTALISH = /^[小合總总計计综総線綫結结]{1,2}$/;
  function suspiciousTotalRows(table = [], known = new Set()) {
    const st = getSmartTotals();
    if (!st) return [];
    const out = [];
    for (let r = 0; r < table.length; r++) {
      if (known.has(r)) continue;
      const label = String(st.rowLabel(table[r], v => Validator._num(v)) || '').replace(/\s/g, '');
      if (!label || label.length > 2 || !TOTALISH.test(label)) continue;
      if (st.isTotalLabel(label)) continue;
      if (!table[r].some(v => !isNaN(Validator._num(v)))) continue;
      out.push({ r, label });
    }
    return out;
  }

  function csvSafeCell(v) {
    let s = String(v ?? '');
    if (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^-+$/.test(s) && isNaN(Validator._num(s)))) {
      s = "'" + s;
    }
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /* 欄／列的驗算角色狀態操作 */
  const emptySel = () => ({ plus: [], minus: [], mul: [], div: [], order: [], total: null });
  const cloneSel = k => ({
    plus: [...(k?.plus || [])],
    minus: [...(k?.minus || [])],
    mul: [...(k?.mul || [])],
    div: [...(k?.div || [])],
    order: [...(k?.order || [])],
    total: k?.total ?? null,
  });

  function selCountOf(sel, kind) {
    const k = sel[kind];
    return k.plus.length + k.minus.length + (k.mul?.length || 0) + (k.div?.length || 0) + (k.total !== null ? 1 : 0);
  }
  function selReadyOf(sel, kind) {
    const k = sel[kind];
    return (k.mul?.length || k.div?.length) ? selCountOf(sel, kind) === 3 : selCountOf(sel, kind) >= 2;
  }
  function autoTotalIndexOf(sel, kind) {
    const k = sel[kind];
    if (k.total !== null) return null;
    const ordered = k.order?.length ? k.order : [...k.plus, ...k.minus, ...(k.mul || []), ...(k.div || [])];
    return ordered.length >= 2 ? ordered[ordered.length - 1] : null;
  }
  function selIndicesOf(sel, kind) {
    const k = sel[kind];
    const auto = autoTotalIndexOf(sel, kind);
    const all = [...k.plus, ...k.minus, ...(k.mul || []), ...(k.div || [])];
    const idx = all.filter(i => i !== auto);
    if (k.total !== null) idx.push(k.total);
    else if (auto !== null) idx.push(auto);
    return idx;
  }
  function selSignsOf(sel, kind) {
    const m = new Map();
    sel[kind].plus.forEach(i => m.set(i, 1));
    sel[kind].minus.forEach(i => m.set(i, -1));
    (sel[kind].mul || []).forEach(i => m.set(i, 2));
    (sel[kind].div || []).forEach(i => m.set(i, -2));
    return m;
  }

  function setRoleOn(sel, kind, idx, role) {
    const k = sel[kind];
    k.mul = k.mul || []; k.div = k.div || []; k.order = k.order || [];
    const cur = k.total === idx ? 0
      : k.plus.includes(idx) ? 1
      : k.minus.includes(idx) ? -1
      : k.mul.includes(idx) ? 2
      : k.div.includes(idx) ? -2
      : null;
    k.plus = k.plus.filter(i => i !== idx);
    k.minus = k.minus.filter(i => i !== idx);
    k.mul = k.mul.filter(i => i !== idx);
    k.div = k.div.filter(i => i !== idx);
    k.order = k.order.filter(i => i !== idx);
    if (k.total === idx) k.total = null;
    if (cur === role) return;
    const isOp = r => r === 2 || r === -2;
    const hasAddSub = k.plus.length > 0 || k.minus.length > 0;
    const curOp = k.mul.length ? 2 : k.div.length ? -2 : null;
    if (role !== 0 && ((isOp(role) && (hasAddSub || (curOp && curOp !== role))) || (curOp && !isOp(role)))) {
      Object.assign(k, emptySel());
    }
    if ((isOp(role) || (role === 0 && curOp && k.total === null)) && selCountOf(sel, kind) >= 3) return 'full';
    if (role === 0) k.total = idx;
    else {
      if (role === 1) k.plus.push(idx);
      else if (role === -1) k.minus.push(idx);
      else if (role === 2) k.mul.push(idx);
      else if (role === -2) k.div.push(idx);
      k.order.push(idx);
    }
  }

  function removeSelOn(sel, kind, idx) {
    const k = sel[kind];
    k.plus = k.plus.filter(i => i !== idx);
    k.minus = k.minus.filter(i => i !== idx);
    if (k.mul) k.mul = k.mul.filter(i => i !== idx);
    if (k.div) k.div = k.div.filter(i => i !== idx);
    if (k.order) k.order = k.order.filter(i => i !== idx);
    if (k.total === idx) k.total = null;
  }

  function addRangeOn(sel, kind, idx, selMode = 1) {
    const k = sel[kind];
    k.mul = k.mul || []; k.div = k.div || []; k.order = k.order || [];
    const ordered = k.order.length ? k.order : [...k.plus, ...k.minus, ...k.mul, ...k.div];
    const anchor = ordered.slice(-1)[0];
    if (anchor === undefined || k.mul.length || k.div.length || Math.abs(selMode) === 2) return setRoleOn(sel, kind, idx, selMode);
    const lo = Math.min(anchor, idx), hi = Math.max(anchor, idx);
    for (let i = lo; i <= hi; i++) {
      if (i === k.total || k.plus.includes(i) || k.minus.includes(i) || k.mul.includes(i) || k.div.includes(i)) continue;
      k.plus.push(i);
      k.order.push(i);
    }
  }

  const api = {
    FULLWIDTH_MAP, MINUS_VARIANTS, CONFUSABLES, toHalfWidth, fixThousandDots,
    Validator, repairNumericCells, AMOUNT_SHAPE, NO_VALUE, isAmountColumn,
    stripGarbageText, unparsedNumericCells, TOTALISH, suspiciousTotalRows, csvSafeCell,
    emptySel, cloneSel, setRoleOn, removeSelOn, addRangeOn,
    selCountOf, selReadyOf, autoTotalIndexOf, selIndicesOf, selSignsOf,
  };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
