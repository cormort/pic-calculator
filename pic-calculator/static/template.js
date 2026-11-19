/* 沿用上一張的驗算設定（同格式表格連續處理）。
 * 純函式模組（不碰 DOM），可供瀏覽器與 Node 單元測試共用。
 */
(function (root) {
  "use strict";

  // 科目名稱比對忽略標點：OCR 常漏讀「、」，括號／全形半形混用也會讓同一列對不上
  function squashLabel(s) {
    const punct = /[、，,。．.：:；;・·（）()「」『』\[\]【】\-–—_/\\|]/g;
    return String(s ?? '').replace(/\s+/g, '').replace(punct, '');
  }

  // 表頭比對時忽略數字：年度、月份每張不同（「113年1月實支」→「年月實支」）
  function templateKey(s) {
    const punct = /[、，,。．.：:；;・·（）()「」『』\[\]【】\-–—_/\\|]/g;
    return String(s ?? '').replace(/[\s\d]+/g, '').replace(punct, '');
  }

  // 欄的「形狀」＝每一欄有幾成是數字，用來擋欄數與表頭剛好對上但型態不同的誤套
  function columnShape(table) {
    const cols = Math.max(0, ...table.map(r => r.length));
    const shape = [];
    for (let c = 0; c < cols; c++) {
      const vals = table.slice(1).map(r => String(r?.[c] ?? '').trim()).filter(Boolean);
      if (!vals.length) { shape.push(0); continue; }
      const numeric = vals.filter(v => !isNaN(parseFloat(v.replace(/[,，\s$]/g, '')))).length;
      shape.push(numeric / vals.length);
    }
    return shape;
  }

  function makeTemplate(table, selection, totalRows, labelOf) {
    const label = r => squashLabel(labelOf(table[r]));
    const size = k => k.plus.length + k.minus.length + (k.mul?.length || 0) + (k.div?.length || 0) + (k.total !== null ? 1 : 0);
    const { col, row } = selection;
    const totals = [...totalRows].map(label).filter(Boolean);
    if (!size(col) && !size(row) && !totals.length) return null;

    let colTpl = null;
    if (size(col)) {
      colTpl = { plus: [...col.plus], minus: [...col.minus], total: col.total };
      if (col.mul?.length) colTpl.mul = [...col.mul];
      if (col.div?.length) colTpl.div = [...col.div];
      if (col.order?.length) colTpl.order = [...col.order];
    }

    let rowTpl = null;
    if (size(row)) {
      rowTpl = {
        plus: row.plus.map(label),
        minus: row.minus.map(label),
        total: row.total !== null ? label(row.total) : null,
      };
      if (row.mul?.length) rowTpl.mul = row.mul.map(label);
      if (row.div?.length) rowTpl.div = row.div.map(label);
      if (row.order?.length) rowTpl.order = row.order.map(label);
    }

    return {
      ncols: Math.max(0, ...table.map(r => r.length)),
      header: (table[0] || []).map(templateKey),
      col: colTpl,
      row: rowTpl,
      totals,
      shape: columnShape(table),
    };
  }

  function matchTemplate(tpl, table, labelOf) {
    const ncols = Math.max(0, ...table.map(r => r.length));
    if (ncols !== tpl.ncols) return { ok: false, reason: `欄數不同（上一張 ${tpl.ncols} 欄、這張 ${ncols} 欄）` };
    const header = (table[0] || []).map(templateKey);
    const filled = Math.max(header.filter(Boolean).length, tpl.header.filter(Boolean).length);
    const same = header.filter((h, c) => h && h === tpl.header[c]).length;
    if (!filled || same / filled < 0.6) return { ok: false, reason: '表頭不同' };

    const labels = table.map(r => squashLabel(labelOf(r)));
    const find = l => {
      const i = l ? labels.indexOf(l) : -1;
      return i >= 0 && labels.indexOf(l, i + 1) < 0 ? i : -1;
    };

    let row = null, rowSkipped = false;
    if (tpl.row) {
      const plus = (tpl.row.plus || []).map(find);
      const minus = (tpl.row.minus || []).map(find);
      const mul = (tpl.row.mul || []).map(find);
      const div = (tpl.row.div || []).map(find);
      const order = (tpl.row.order || []).map(find);
      const total = tpl.row.total === null ? null : find(tpl.row.total);
      if ([...plus, ...minus, ...mul, ...div, ...order, total ?? 0].every(i => i >= 0)) {
        row = { plus, minus, total };
        if (mul.length) row.mul = mul;
        if (div.length) row.div = div;
        if (order.length) row.order = order;
      } else {
        rowSkipped = true;
      }
    }

    let col = null;
    if (tpl.col) {
      col = { plus: [...(tpl.col.plus || [])], minus: [...(tpl.col.minus || [])], total: tpl.col.total ?? null };
      if (tpl.col.mul?.length) col.mul = [...tpl.col.mul];
      if (tpl.col.div?.length) col.div = [...tpl.col.div];
      if (tpl.col.order?.length) col.order = [...tpl.col.order];
    }

    if (Array.isArray(tpl.shape) && tpl.shape.length === ncols) {
      const cols = ncols;
      let diff = 0, n = 0;
      for (let c = 0; c < cols; c++) {
        const vals = table.slice(1).map(r => String(r?.[c] ?? '').trim()).filter(Boolean);
        if (!vals.length) continue;
        const numeric = vals.filter(v => !isNaN(parseFloat(v.replace(/[,，\s$]/g, '')))).length / vals.length;
        diff += Math.abs(numeric - (tpl.shape[c] ?? 0));
        n += 1;
      }
      if (n && diff / n > 0.34) return { ok: false, reason: '欄位內容的型態不同（可能不是同一張報表）' };
    }

    const totals = labels.flatMap((l, r) => l && tpl.totals.includes(l) ? [r] : []);
    return { ok: true, col, row, rowSkipped, totals };
  }

  function describeRoles(kind, k) {
    const n = i => (kind === 'col' ? '欄' : '列') + (i + 1);
    const fmtOp = (arr, sym) => {
      if (k.total === null && arr.length === 3) {
        return `${n(arr[0])}${sym}${n(arr[1])}＝${n(arr[2])}`;
      }
      const expr = arr.map((i, idx) => (idx ? sym : '') + n(i)).join('');
      return expr + (k.total !== null && k.total !== undefined ? '＝' + n(k.total) : '');
    };
    if (k.mul?.length) return fmtOp(k.mul, '×');
    if (k.div?.length) return fmtOp(k.div, '÷');
    return [...(k.plus || []).map(i => '＋' + n(i)), ...(k.minus || []).map(i => '−' + n(i))]
      .join('').replace(/^＋/, '')
      + (k.total !== null && k.total !== undefined ? '＝' + n(k.total) : '');
  }

  const api = { squashLabel, templateKey, columnShape, makeTemplate, matchTemplate, describeRoles };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
