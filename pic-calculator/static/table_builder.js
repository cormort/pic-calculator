/* 表格重建（buildTable）、貼上文字解析、PDF 文字層座標萃取。
 * 純函式模組（不碰 DOM），可供瀏覽器與 Node 單元測試共用。
 */
(function (root) {
  "use strict";

  const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

  function getValidator() {
    if (root.Validator) return root.Validator;
    if (typeof require === 'function') {
      try { return require('./validator.js').Validator; } catch (e) { return null; }
    }
    return null;
  }

  /* 一個字大約佔幾個「半形字寬」：中文 1、數字／英文 0.55、標點 0.4。
     只用來把「格線落在第幾個字之間」換算出來，不需要很準。 */
  function charWidth(ch) {
    if (/[\u2e80-\u9fff\uff01-\uff60]/.test(ch)) return 1;
    if (/[0-9a-zA-Z]/.test(ch)) return 0.55;
    if (/[\s]/.test(ch)) return 0.3;
    return 0.4;
  }

  /* 偵測框跨過格線時拆成兩格。 */
  function splitBoxAtLine(w, vLines) {
    const Validator = getValidator();
    let boxes = [w];
    for (const line of vLines) {
      const next = [];
      for (const b of boxes) {
        const x = line.a + line.b * b.cy;
        const text = b.text;
        const wPx = b.x2 - b.x1;
        if (text.length < 2 || wPx <= 0) { next.push(b); continue; }
        const frac = (x - b.x1) / wPx;
        if (frac <= 0.1 || frac >= 0.9) { next.push(b); continue; }
        const total = [...text].reduce((s, ch) => s + charWidth(ch), 0);
        const target = frac * total;
        let acc = 0, idx = 0;
        for (let i = 0; i < text.length; i++) {
          const cw = charWidth(text[i]);
          if (acc + cw / 2 > target) { idx = i; break; }
          acc += cw;
          idx = i + 1;
        }
        if (idx <= 0 || idx >= text.length) { next.push(b); continue; }
        if (idx === 1 && /[\u4e00-\u9fff]/.test(text[0]) && /[\u4e00-\u9fff]/.test(text[1])) { next.push(b); continue; }
        if (Validator && !isNaN(Validator._num(text))) { next.push(b); continue; }
        const left = text.slice(0, idx), right = text.slice(idx);
        next.push(
          { ...b, text: left, x2: x, cx: (b.x1 + x) / 2, splitLine: true },
          { ...b, text: right, x1: x, cx: (x + b.x2) / 2, splitLine: true }
        );
      }
      boxes = next;
    }
    return boxes;
  }

  // grid（可省略）：Worker 偵測到的表格格線 { v: [{a,b}], h: [{a,b}] }，直線 x = a + b*y、橫線 y = a + b*x
  function buildTable(words, grid) {
    const Validator = getValidator();
    if (!words.length) return { data: [], confidence: [], boxes: [] };
    const avg = (a, f) => a.reduce((s, v) => s + f(v), 0) / a.length;

    const vLines = grid?.v || [], hLines = grid?.h || [];
    const wholeNum = t => Validator && !isNaN(Validator._num(t)) && /\d$/.test(t) && /^[-(（$\d]/.test(t);
    words = words.flatMap(w => {
      const parts = w.text.split(/\s+/).filter(Boolean);
      if (parts.length < 2 || !parts.every(wholeNum)) return [w];
      const per = (w.x2 - w.x1) / w.text.length;
      let pos = 0;
      return parts.map(text => {
        const at = w.text.indexOf(text, pos);
        pos = at + text.length;
        const x1 = w.x1 + at * per, x2 = w.x1 + pos * per;
        return { ...w, text, x1, x2, cx: (x1 + x2) / 2, split: true };
      });
    });

    if (vLines.length && !grid?.exact) words = words.flatMap(w => splitBoxAtLine(w, vLines));

    // 先記下未做歪斜旋轉前的原始字框範圍（ox1, ox2, oy1, oy2），給原圖對照使用
    const top = hLines[0];
    words = words.map(w => ({
      ...w,
      ox: w.cx,
      oy: w.cy,
      ox1: w.x1,
      ox2: w.x2,
      oy1: Number.isFinite(w.y1) ? w.y1 : w.cy - (w.h || 0) / 2,
      oy2: Number.isFinite(w.y2) ? w.y2 : w.cy + (w.h || 0) / 2,
      seg: vLines.reduce((n, l) => n + (l.a + l.b * w.cy < w.cx ? 1 : 0), 0),
      out: !!grid?.exact && hLines.length >= 2 && w.cy < top.a + top.b * w.cx,
    }));

    // 校正歪斜：在 ±15° 內找出讓文字框「排成列」最整齊的角度
    const binH = avg(words, w => w.h) / 2;
    let skew = 0, bestScore = -1;
    for (let deg = -15; !grid?.exact && deg <= 15; deg += 0.25) {
      const t = deg * Math.PI / 180, sin = Math.sin(t), cos = Math.cos(t), bins = new Map();
      for (const w of words) { const b = Math.round((w.cy * cos - w.cx * sin) / binH); bins.set(b, (bins.get(b) || 0) + 1); }
      let score = 0;
      for (const n of bins.values()) score += n * n;
      if (score > bestScore || (score === bestScore && Math.abs(deg) < Math.abs(skew))) { bestScore = score; skew = deg; }
    }
    if (skew) {
      const t = skew * Math.PI / 180, sin = Math.sin(t), cos = Math.cos(t);
      words = words.map(w => {
        const cx = w.cx * cos + w.cy * sin, cy = w.cy * cos - w.cx * sin, hw = (w.x2 - w.x1) / 2;
        return { ...w, cx, cy, x1: cx - hw, x2: cx + hw };
      });
    }

    // 依 y 中心分列
    const yTol = Math.max(avg(words, w => w.h) * 0.55, 6);
    const rows = [];
    let cur = [], lastCy = 0;
    for (const w of [...words].sort((a, b) => a.cy - b.cy)) {
      let sameRow = !cur.length || Math.abs(w.cy - lastCy) <= yTol;
      if (!sameRow) {
        const hasXOverlap = cur.some(c => Math.min(c.x2, w.x2) > Math.max(c.x1, w.x1));
        if (!hasXOverlap) {
          let nearest = cur[0], minDx = Infinity;
          for (const c of cur) {
            const dx = Math.abs(c.cx - w.cx);
            if (dx < minDx) { minDx = dx; nearest = c; }
          }
          const yOverlap = Math.min(nearest.cy + nearest.h / 2, w.cy + w.h / 2) - Math.max(nearest.cy - nearest.h / 2, w.cy - w.h / 2);
          if (Math.abs(w.cy - nearest.cy) <= yTol * 1.25 && yOverlap >= 0.25 * Math.min(w.h, nearest.h)) {
            sameRow = true;
          }
        }
      }
      if (!sameRow) { rows.push(cur); cur = []; }
      cur.push(w);
      lastCy = avg(cur, c => c.cy);
    }
    rows.push(cur);

    // 同列內相鄰文字框合併成 cell；信心取最小值
    const isNum = t => Validator && !isNaN(Validator._num(t));
    const cellRows = rows.map(row => {
      const rowH = avg(row, w => w.h);
      const gapTol = Math.max(rowH * 0.7, 8);
      const cells = [];
      for (const w of row.sort((a, b) => a.x1 - b.x1)) {
        const last = cells[cells.length - 1];
        const twoNumbers = last && (w.split || w.x1 - last.x2 > rowH * 0.3)
          && isNum(last.text) && isNum(w.text)
          && !/[,，.\-(（]$/.test(last.text) && !/^[,，.)）%％]/.test(w.text);
        const overlap = last ? Math.min(last.x2, w.x2) - Math.max(last.x1, w.x1) : 0;
        const smallW = last ? Math.min(last.x2 - last.x1, w.x2 - w.x1) : 0;
        const near = last && w.x1 - last.x2 <= gapTol;
        const dup = last && smallW > 0
          && (last.splitLine || w.splitLine || Math.min(last.text.length, w.text.length) <= 2)
          && (last.text.includes(w.text) || w.text.includes(last.text))
          && (overlap > 0.5 * smallW || (last.seg === w.seg && near));
        if (dup) {
          const keep = w.text.length > last.text.length ? w.text : last.text;
          const keepScore = w.text.length > last.text.length ? (w.score ?? 1) : last.score;
          last.text = keep;
          last.score = Math.min(keepScore, Math.max(last.score, w.score ?? 1));
          last.x1 = Math.min(last.x1, w.x1);
          last.x2 = Math.max(last.x2, w.x2);
          last.ox1 = Math.min(last.ox1, w.ox1);
          last.ox2 = Math.max(last.ox2, w.ox2);
          last.oy1 = Math.min(last.oy1, w.oy1);
          last.oy2 = Math.max(last.oy2, w.oy2);
        } else if (last && !twoNumbers && (last.seg === w.seg || w.out) && w.x1 - last.x2 <= gapTol) {
          last.text += (CJK.test(last.text.slice(-1)) || CJK.test(w.text[0]) ? '' : ' ') + w.text;
          last.x2 = Math.max(last.x2, w.x2);
          last.y1 = Math.min(last.y1, w.y1);
          last.y2 = Math.max(last.y2, w.y2);
          last.ox1 = Math.min(last.ox1, w.ox1);
          last.ox2 = Math.max(last.ox2, w.ox2);
          last.oy1 = Math.min(last.oy1, w.oy1);
          last.oy2 = Math.max(last.oy2, w.oy2);
          last.score = Math.min(last.score, w.score ?? 1);
        } else {
          cells.push({
            text: w.text, x1: w.x1, x2: w.x2, y1: w.y1, y2: w.y2,
            ox1: w.ox1, ox2: w.ox2, oy1: w.oy1, oy2: w.oy2,
            score: w.score ?? 1, seg: w.seg, splitLine: w.splitLine, out: w.out,
          });
        }
      }
      cells.forEach(c => { c.cx = (c.x1 + c.x2) / 2; });
      return cells;
    });

    // 跨列對齊欄位：用垂直空白帶切欄
    const numericRows = cellRows.filter(row => !row[0]?.out && row.some(c => isNum(c.text)));
    const sample = numericRows.length ? numericRows : cellRows.filter(r => r.length >= 2);
    const sampleRows = sample.length ? sample : cellRows;
    const heights = words.map(w => w.h).sort((a, b) => a - b);
    const medH = heights[heights.length >> 1] || 20;
    const minGap = Math.max(medH * 0.8, 12);

    const bandsOf = seg => {
      const segRows = sampleRows.map(row => row.filter(c => c.seg === seg));
      const intervals = segRows.flatMap(row => row.map(c => [c.x1, c.x2])).sort((a, b) => a[0] - b[0]);
      if (!intervals.length) return [-Infinity, Infinity];
      const merged = [];
      for (const [x1, x2] of intervals) {
        const last = merged[merged.length - 1];
        if (last && x1 <= last[1]) last[1] = Math.max(last[1], x2);
        else merged.push([x1, x2]);
      }
      const straddled = (L, R) => segRows.filter(row =>
        row.some((c, k) => k > 0 && row[k - 1].x2 <= L && c.x1 >= R)).length >= 2;
      const bounds = [merged[0][0]];
      for (let i = 1; i < merged.length; i++) {
        const L = merged[i - 1][1], R = merged[i][0];
        if (R - L >= minGap || straddled(L, R)) bounds.push((L + R) / 2);
      }
      bounds.push(merged[merged.length - 1][1]);
      return bounds;
    };

    const allCells = cellRows.flat();
    if (!allCells.length) return { data: [], confidence: [], boxes: [] };
    const segMin = Math.min(...allCells.map(c => c.seg)), segMax = Math.max(...allCells.map(c => c.seg));
    const segBounds = [], segOffset = [];
    let ncols = 0;
    for (let seg = segMin; seg <= segMax; seg++) {
      segBounds[seg] = bandsOf(seg);
      segOffset[seg] = ncols;
      ncols += Math.max(segBounds[seg].length - 1, 1);
    }

    const colOf = cell => {
      const bounds = segBounds[cell.seg];
      let best = 0, bestOverlap = -1;
      for (let i = 0; i < bounds.length - 1; i++) {
        const overlap = Math.min(cell.x2, bounds[i + 1]) - Math.max(cell.x1, bounds[i]);
        if (overlap > bestOverlap) { best = i; bestOverlap = overlap; }
      }
      if (bestOverlap <= 0) {
        let bestDist = Infinity;
        for (let i = 0; i < bounds.length - 1; i++) {
          const d = Math.abs((bounds[i] + bounds[i + 1]) / 2 - cell.cx);
          if (d < bestDist) { bestDist = d; best = i; }
        }
      }
      return segOffset[cell.seg] + best;
    };

    const joinText = (a, b, sep) => !a ? b : a + (CJK.test(a.slice(-1)) || CJK.test(b[0]) ? sep : ' ') + b;
    let outRows = cellRows.map((row, i) => {
      const out = Array(ncols).fill('');
      const conf = Array(ncols).fill(1);
      const box = Array(ncols).fill(null);
      const y1r = row.length ? Math.min(...row.map(w => (w.oy1 ?? w.y1 ?? (w.cy - (w.h || 0) / 2)))) : 0;
      const y2r = row.length ? Math.max(...row.map(w => (w.oy2 ?? w.y2 ?? (w.cy + (w.h || 0) / 2)))) : 0;
      for (const c of row) {
        const ci = colOf(c);
        out[ci] = out[ci] ? out[ci] + ' ' + c.text : c.text;
        conf[ci] = Math.min(conf[ci], Number.isFinite(c.score) ? c.score : 1);
        const cx1 = Number.isFinite(c.ox1) ? c.ox1 : c.x1;
        const cx2 = Number.isFinite(c.ox2) ? c.ox2 : c.x2;
        const cy1 = Number.isFinite(c.oy1) ? c.oy1 : (Number.isFinite(c.y1) ? c.y1 : y1r);
        const cy2 = Number.isFinite(c.oy2) ? c.oy2 : (Number.isFinite(c.y2) ? c.y2 : y2r);
        const b = { x1: cx1, x2: cx2, y1: cy1, y2: cy2 };
        const prev = box[ci];
        box[ci] = prev
          ? {
              x1: Math.min(prev.x1, b.x1), x2: Math.max(prev.x2, b.x2),
              y1: Math.min(prev.y1, b.y1), y2: Math.max(prev.y2, b.y2),
            }
          : b;
      }
      const x = avg(rows[i], w => w.ox), y = avg(rows[i], w => w.oy);
      return { out, conf, box, band: hLines.reduce((n, l) => n + (l.a + l.b * x < y ? 1 : 0), 0) };
    });

    // 橫線之間有兩行字（表頭或科目名稱換行）→ 併回同一列
    const inside = outRows.filter(r => r.band > 0 && r.band < hLines.length);
    if (hLines.length >= 3 && new Set(inside.map(r => r.band)).size >= inside.length * 0.6) {
      const hasNum = r => r.out.some(t => isNum(t));
      const groups = [];
      for (const r of outRows) {
        const g = groups[groups.length - 1];
        if (g && g[0].band === r.band && r.band > 0 && r.band < hLines.length) g.push(r);
        else groups.push([r]);
      }
      outRows = groups.flatMap(g => {
        if (g.length < 2 || g.filter(hasNum).length > 1) return g;
        const first = g[0];
        for (const r of g.slice(1)) {
          r.out.forEach((t, c) => { if (t) first.out[c] = joinText(first.out[c], t, ''); });
          r.conf.forEach((v, c) => { first.conf[c] = Math.min(first.conf[c], v); });
          r.box.forEach((b, c) => {
            if (!b) return;
            first.box[c] = first.box[c]
              ? {
                  x1: Math.min(first.box[c].x1, b.x1), x2: Math.max(first.box[c].x2, b.x2),
                  y1: Math.min(first.box[c].y1, b.y1), y2: Math.max(first.box[c].y2, b.y2),
                }
              : b;
          });
        }
        return [first];
      });
    }

    // 表格上方的標題（沒有任何數字）當成標題丟掉
    while (hLines.length >= 2 && outRows.length > 2
      && outRows[0].band === 0 && outRows[1].band > 0
      && !outRows[0].out.some(t => isNum(t))) {
      outRows.shift();
    }

    // 去掉整欄空白
    const emptyCols = [];
    for (let c = 0; c < ncols; c++) if (outRows.every(r => !r.out[c])) emptyCols.push(c);
    if (emptyCols.length) {
      outRows = outRows.map(r => ({
        ...r,
        out: r.out.filter((_, c) => !emptyCols.includes(c)),
        conf: r.conf.filter((_, c) => !emptyCols.includes(c)),
        box: r.box.filter((_, c) => !emptyCols.includes(c)),
      }));
    }
    let from = 0, keep = Math.max(1, ncols - emptyCols.length);
    while (keep > 1 && outRows.every(r => !r.out[keep - 1])) keep--;
    while (from < keep - 1 && outRows.every(r => !r.out[from])) from++;

    return {
      data: outRows.map(r => r.out.slice(from, keep)),
      confidence: outRows.map(r => r.conf.slice(from, keep).map(s => Math.round(s * 1000) / 1000)),
      boxes: outRows.map(r => r.box.slice(from, keep)),
    };
  }

  /* =============================================================
     貼上文字／表格解析
     ============================================================= */
  function parseCsvLine(line) {
    const out = [];
    let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',' || ch === '，') { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  }

  function splitLabelAmount(line) {
    const t = line.trim();
    const m = t.match(/^(.*?)[\s:：]+((?:NT\$|\$)?\s*-?[\d,]+(?:\.\d+)?\s*(?:元|%|％)?)$/);
    if (m && m[1].trim()) return [m[1].trim(), m[2].replace(/\s+/g, '')];
    return [t];
  }

  function parsePastedTable(text) {
    const raw = String(text || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
    const lines = raw.split('\n').filter(l => l.trim() !== '');
    if (!lines.length) return [];

    const tabs = lines.filter(l => l.includes('\t')).length;
    let grid;
    if (tabs >= Math.ceil(lines.length * 0.6)) {
      grid = lines.map(l => l.split('\t').map(c => c.trim()));
    } else if (lines.filter(l => {
      const digitCommas = (l.match(/(?<=\d)[,，](?=\d{3}(\D|$))/g) || []).length;
      const commas = (l.match(/[,，]/g) || []).length;
      return commas > digitCommas && parseCsvLine(l).length >= 2;
    }).length >= Math.ceil(lines.length * 0.8)) {
      grid = lines.map(parseCsvLine);
    } else if (lines.filter(l => /\S\s{2,}\S|\u3000\u3000/.test(l)).length >= Math.ceil(lines.length * 0.6)) {
      grid = lines.map(l => l.split(/\s{2,}|\u3000+/).map(c => c.trim()));
    } else {
      grid = lines.map(splitLabelAmount);
    }

    const ncol = Math.max(...grid.map(r => r.length));
    for (const r of grid) while (r.length < ncol) r.push('');
    let keep = ncol;
    while (keep > 1 && grid.every(r => !r[keep - 1])) keep--;
    return grid.map(r => r.slice(0, keep));
  }

  /* =============================================================
     PDF 文字層 → words 與檢查函式
     ============================================================= */
  function pdfTextWords(items, viewport, util) {
    const Util = util || root.pdfjsLib?.Util;
    const out = [];
    const wsum = s => [...s].reduce((n, ch) => n + charWidth(ch), 0);
    for (const item of items) {
      const raw = (item.str || '').normalize('NFKC');
      if (!raw.trim()) continue;
      const m = Util.transform(viewport.transform, item.transform);
      const fontSize = Math.hypot(m[2], m[3]) || viewport.scale * 10;
      const len = Math.hypot(m[0], m[1]) || 1, ux = m[0] / len, uy = m[1] / len;
      const adv = Math.max(item.width * viewport.scale, fontSize * 0.3);
      const total = wsum(raw) || 1;
      for (const part of raw.matchAll(/\S+(?:\s\S+)*/g)) {
        const a = wsum(raw.slice(0, part.index)) / total * adv;
        const b = a + wsum(part[0]) / total * adv;
        const xs = [], ys = [];
        for (const t of [a, b]) for (const s of [0.85 * fontSize, -0.25 * fontSize]) {
          xs.push(m[4] + ux * t + uy * s);
          ys.push(m[5] + uy * t - ux * s);
        }
        const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);
        const tol = fontSize * 0.15;
        if (out.some(o => o.text === part[0] && Math.abs(o.x1 - x1) < tol && Math.abs(o.y1 - y1) < tol)) continue;
        out.push({
          text: part[0], x1, x2, y1, y2,
          cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, h: fontSize * 1.1, score: 1,
        });
      }
    }
    return out;
  }

  function textLayerGarbled(words) {
    const text = words.map(w => w.text).join('');
    const bad = (text.match(/[\ufffd\ue000-\uf8ff\u0000-\u001f]/g) || []).length;
    return bad > text.length * 0.1;
  }

  function textMostlyHidden(fnArray, argsArray, OPS) {
    const shows = [OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText];
    const stack = [];
    let mode = 0, hidden = 0, visible = 0;
    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];
      if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) stack.push(mode);
      else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) mode = stack.pop() ?? 0;
      else if (fn === OPS.setTextRenderingMode) mode = argsArray[i][0];
      else if (shows.includes(fn)) {
        const n = argsArray[i]?.[0]?.length || 1;
        if (mode === 3 || mode === 7) hidden += n; else visible += n;
      }
    }
    return hidden > visible;
  }

  function hasUsableTextLayer(words) {
    if (!words || words.length < 8) return false;
    const chars = words.reduce((n, w) => n + w.text.length, 0);
    return chars >= 20;
  }

  function filterWordsByQuad(words, q, size) {
    if (!q || !size) return words;
    const isFull = Math.abs(q[0][0]) < 1e-6 && Math.abs(q[0][1]) < 1e-6
      && Math.abs(q[1][0] - 1) < 1e-6 && Math.abs(q[2][1] - 1) < 1e-6;
    if (isFull) return words;
    const poly = q.map(([x, y]) => [x * size.width, y * size.height]);
    const inside = (x, y) => {
      let hit = false;
      for (let i = 0, j = 3; i < 4; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    };
    return words.filter(w => inside(w.cx, w.cy));
  }

  const api = {
    CJK, charWidth, splitBoxAtLine, buildTable,
    parseCsvLine, splitLabelAmount, parsePastedTable,
    pdfTextWords, textLayerGarbled, textMostlyHidden, hasUsableTextLayer, filterWordsByQuad,
  };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
