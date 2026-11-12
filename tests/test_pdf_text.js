/* PDF 文字層（index.html）的純函式測試：座標換算、亂碼與隱藏 OCR 層的判斷。
 * 執行：node tests/test_pdf_text.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(
  path.join(__dirname, "..", "pic-calculator", "static", "index.html"), "utf8");
const fns = ["charWidth", "pdfTextWords", "textLayerGarbled", "textMostlyHidden"]
  .map((fn) => html.match(new RegExp(`function ${fn}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0]).join("\n");
// pdf.js 的 Util.transform：兩個 [a,b,c,d,e,f] 矩陣相乘
const pdfjsLib = { Util: { transform: (m1, m2) => [
  m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]] } };
const { pdfTextWords, textLayerGarbled, textMostlyHidden } = new Function("pdfjsLib",
  fns + "\nreturn { pdfTextWords, textLayerGarbled, textMostlyHidden };")(pdfjsLib);

// 2 倍、y 翻轉的視窗（A4 高 842pt）
const viewport = { scale: 2, transform: [2, 0, 0, -2, 0, 1684] };
const item = (str, x, y, width, t = [10, 0, 0, 10]) => ({ str, width, transform: [...t, x, y] });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.01, `${msg}: ${a} vs ${b}`);

// 1) 水平文字：與原本的算法一致（基線上 0.85、下 0.25 個字高）
let [w] = pdfTextWords([item("50,000", 100, 700, 30)], viewport);
near(w.x1, 200, "x1"); near(w.x2, 260, "x2");
near(w.y1, 284 - 17, "y1"); near(w.y2, 284 + 5, "y2"); near(w.h, 22, "h");

// 2) 頭尾空白不算進字框（item.width 含空白，原本會讓 x2 蓋到隔壁欄）
[w] = pdfTextWords([item("AB  ", 100, 700, 22)], viewport);   // AB=1.1、兩個空白=0.6 個單位
near(w.x2 - w.x1, 44 * 1.1 / 1.7, "去掉尾端空白後的寬度");
assert.strictEqual(w.text, "AB");

// 3) 用空白對齊、幾欄塞在同一個 item：以兩個以上空白切開
const parts = pdfTextWords([item("差旅 費   50,000    1,200", 100, 700, 200)], viewport);
assert.deepStrictEqual(parts.map((p) => p.text), ["差旅 費", "50,000", "1,200"]);
assert.ok(parts[0].x2 < parts[1].x1 && parts[1].x2 < parts[2].x1, "切開後的字框不重疊");
near(parts[2].x2, 200 + 400, "最後一段貼齊 item 右緣");

// 4) 轉 90° 的文字（表頭直書）：字框是直的，h 仍是字高
[w] = pdfTextWords([item("金額", 100, 700, 20, [0, 10, -10, 0])], viewport);
assert.ok(w.y2 - w.y1 > w.x2 - w.x1, "轉向文字的框應該是直的");
near(w.y2 - w.y1, 40, "沿文字方向的長度");
near(w.h, 22, "h 是字高不是框高");

// 5) 康熙部首 → 一般漢字（NFKC）
assert.strictEqual(pdfTextWords([item("⾦額", 0, 0, 20)], viewport)[0].text, "金額");

// 6) 亂碼文字層
const ws = (t) => [{ text: t }];
assert.strictEqual(textLayerGarbled(ws("經費明細表 50,000 合計")), false);
assert.strictEqual(textLayerGarbled(ws(" 12")), true);
assert.strictEqual(textLayerGarbled(ws("��� abc")), true);

// 7) 隱藏 OCR 層：不可見文字（Tr 3）佔多數才算；q/Q 會還原繪字模式
const OPS = { save: 1, restore: 2, setTextRenderingMode: 3, showText: 4, showSpacedText: 5,
  nextLineShowText: 6, nextLineSetSpacingShowText: 7, paintFormXObjectBegin: 8, paintFormXObjectEnd: 9 };
const g = (n) => [new Array(n).fill(0)];
const run = (ops) => textMostlyHidden(ops.map((o) => o[0]), ops.map((o) => o[1]), OPS);
assert.strictEqual(run([[OPS.showText, g(50)]]), false, "一般電子檔");
assert.strictEqual(run([[OPS.setTextRenderingMode, [3]], [OPS.showText, g(50)]]), true, "可搜尋的掃描檔");
assert.strictEqual(run([
  [OPS.save, null], [OPS.setTextRenderingMode, [3]], [OPS.showText, g(5)], [OPS.restore, null],
  [OPS.showText, g(50)],
]), false, "只有少數隱藏字（Q 之後回到可見）");

console.log("PASS  PDF 文字層：座標換算、空白切欄、轉向文字、亂碼與隱藏 OCR 層判斷");
