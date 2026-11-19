/* 文字金額模式：字框拼成全文、中文大數單位換算、「…元」金額萃取、原位文字替換。
 * 純函式模組（不碰 DOM），可供瀏覽器與 Node 單元測試共用。
 */
(function (root) {
  "use strict";

  function getToHalfWidth() {
    if (root.toHalfWidth) return root.toHalfWidth;
    if (typeof require === 'function') {
      try { return require('./validator.js').toHalfWidth; } catch (e) { /* ignore */ }
    }
    return s => String(s ?? '');
  }

  function getSmartTotals() {
    if (root.SmartTotals) return root.SmartTotals;
    if (typeof require === 'function') {
      try { return require('./smart_total.js'); } catch (e) { return null; }
    }
    return null;
  }

  function wordsToText(words) {
    // 依 y 中心把字框分行（與上一框高度重疊過半就算同一行），行內由左到右
    const sorted = [...words].sort((a, b) => a.cy - b.cy);
    const lines = [];
    for (const w of sorted) {
      const line = lines[lines.length - 1];
      if (line && Math.abs(w.cy - line.cy) < Math.min(w.h, line.h) * 0.5) { line.ws.push(w); }
      else lines.push({ cy: w.cy, h: w.h, ws: [w] });
    }
    // 整段接起來不換行：段落折行常把金額切成兩半（「1,430」｜「萬3千元」）
    // OCR 常把千分位逗號讀成點：「5.431萬」→「5,431萬」（首組為 1–9 開頭且點後 3 位才改，避免誤改「0.125億元」「1.22%」）
    return lines.map(l => l.ws.sort((a, b) => a.x1 - b.x1).map(w => w.text).join('')).join('')
      .replace(/(?<![\d.])([1-9]\d{0,2}(?:\.\d{3})+)(?=[萬億兆千仟元])/g, m => m.replace(/\./g, ','));
  }

  const BIG_UNITS = { 兆: 1e12, 億: 1e8, 萬: 1e4 };
  const SMALL_UNITS = { 千: 1e3, 仟: 1e3, 百: 100, 佰: 100, 拾: 10, 十: 10 };

  /* 分節累乘：「5千萬」= 50,000,000、「1千2百萬」= 12,000,000、「2百億」= 20,000,000,000 */
  function chineseMoneyParts(s) {
    const clean = getToHalfWidth()(s).replace(/[,，\s]/g, '');
    if (!clean) return NaN;
    let total = 0, section = 0, pendingNum = null, hasNum = false;
    const re = /([0-9.]+)|([兆億萬千仟百佰拾十])|(.)/g;
    for (const m of clean.matchAll(re)) {
      if (m[1]) {
        if (!/^\d+(?:\.\d+)?$/.test(m[1]) || pendingNum !== null) return NaN;
        pendingNum = parseFloat(m[1]);
        hasNum = true;
      } else if (m[2]) {
        const ch = m[2];
        if (ch in BIG_UNITS) {
          total += (section + (pendingNum ?? 0)) * BIG_UNITS[ch];
          section = 0;
          pendingNum = null;
        } else {
          const factor = pendingNum !== null ? pendingNum : ((ch === '拾' || ch === '十') && section === 0 ? 1 : 0);
          section += factor * SMALL_UNITS[ch];
          pendingNum = null;
        }
      } else {
        return NaN;
      }
    }
    return hasNum ? total + section + (pendingNum ?? 0) : NaN;
  }

  const NON_CURRENCY_BEFORE = /[單多次主公紀西開狀]/;
  const NON_CURRENCY_AFTER = /[年月旦首素件氣老音宵]/;
  const CN_NUM_TAIL = /([零〇壹一貳贰二兩參叁叄三肆四伍五陸六柒七捌八玖九拾十佰百仟千萬億]+)$/;

  function isCurrencyYuan(str, idx) {
    if (str[idx] !== '元') return false;
    if (idx > 0 && NON_CURRENCY_BEFORE.test(str[idx - 1])) return false;
    if (idx + 1 < str.length && NON_CURRENCY_AFTER.test(str[idx + 1])) return false;
    return true;
  }

  function parseYuanPrefix(prefix) {
    const clean = getToHalfWidth()(prefix).replace(/[,，\s]/g, '');
    const m = clean.match(/([0-9.兆億萬千仟百佰拾十]+)$/);
    if (m && /[0-9]/.test(m[1])) {
      const v = chineseMoneyParts(m[1]);
      return Number.isFinite(v) && v > 0 ? v : null;
    }
    const st = getSmartTotals();
    if (st && typeof st.chineseAmount === 'function') {
      const cm = clean.match(CN_NUM_TAIL);
      if (cm) {
        const v = st.chineseAmount(cm[1]);
        return Number.isFinite(v) && v > 0 ? v : null;
      }
    }
    return null;
  }

  function extractAmounts(text) {
    const src = String(text ?? '');
    const items = [];
    for (const lineMatch of src.matchAll(/[^\n]+/g)) {
      let lStart = lineMatch.index;
      let lEnd = lStart + lineMatch[0].length;
      while (lStart < lEnd && /\s/.test(src[lStart])) lStart++;
      while (lEnd > lStart && /\s/.test(src[lEnd - 1])) lEnd--;
      if (lStart >= lEnd) continue;

      const opinion = src.slice(lStart, lEnd).match(/^審核意見[：:,\s]*/);
      if (opinion) lStart += opinion[0].length;

      let sStart = lStart;
      while (sStart < lEnd) {
        let sEnd = lEnd;
        for (let k = sStart; k < lEnd; k++) {
          if (src[k] === '。' || src[k] === '；') { sEnd = k + 1; break; }
        }
        let a = sStart, b = sEnd;
        while (a < b && /\s/.test(src[a])) a++;
        while (a < b && (src[a] === ',' || src[a] === '，')) a++;
        while (a < b && /\s/.test(src[a])) a++;
        while (b > a && /\s/.test(src[b - 1])) b--;

        const yuans = [];
        for (let k = a; k < b; k++) {
          if (isCurrencyYuan(src, k)) yuans.push(k);
        }
        if (yuans.length) {
          let segStart = a;
          for (let yi = 0; yi < yuans.length; yi++) {
            const yPos = yuans[yi];
            const isLast = yi === yuans.length - 1;
            let segEnd = yPos + 1;
            if (isLast && src.slice(segEnd, b).trim()) segEnd = b;
            while (segStart < segEnd && /[,，\s]/.test(src[segStart])) segStart++;
            const segText = src.slice(segStart, segEnd);
            const value = parseYuanPrefix(src.slice(segStart, yPos));
            items.push({ text: segText, start: segStart, end: segEnd, value });
            segStart = yPos + 1;
          }
        }
        sStart = sEnd;
      }
    }
    return items;
  }

  function replaceTextSpan(fullText, item, replacement) {
    if (!item || typeof item.start !== 'number' || typeof item.end !== 'number') return fullText;
    return fullText.slice(0, item.start) + replacement + fullText.slice(item.end);
  }

  function zhMoney(n) {   // 1234567 → 123萬4,567元；負數 → 短絀…
    if (!n) return '0元';
    let a = Math.abs(n);
    const parts = [];
    for (const [u, k] of [['兆', 1e12], ['億', 1e8], ['萬', 1e4]]) {
      const q = Math.floor(a / k); a %= k;
      if (q) parts.push(q.toLocaleString('zh-Hant') + u);
    }
    if (a) parts.push(a % 1000 === 0 ? a / 1000 + '千' : a.toLocaleString('zh-Hant'));
    return (n < 0 ? '短絀' : '') + parts.join('') + '元';
  }

  const api = { wordsToText, chineseMoneyParts, extractAmounts, replaceTextSpan, zhMoney };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
