/* 混合 PDF 的逐頁判斷回歸測試（Playwright）。
 *
 * 這份 PDF 有三頁：文字頁 → 掃描頁 → 文字頁。
 * 要驗的是「每一頁各自判斷」：有文字層就走文字層、沒有就退回 OCR，來回換頁不會殘留狀態。
 *
 * 用法：
 *   python3 -m http.server 8765 --bind 127.0.0.1 --directory pic-calculator/static &
 *   node bench/check_mixed_pdf.js                       # 預設 http://127.0.0.1:8765/
 *   node bench/check_mixed_pdf.js --base=https://cormort.github.io/pic-calculator/
 */
const path = require("path");
const { chromium } = require("playwright");

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const BASE = arg("base", "http://127.0.0.1:8765/");
const PDF = path.join(__dirname, "probe", "shots", "mixed-3pages.pdf");

// 每一頁的期望：有沒有文字層、欄列數
const EXPECT = [
  { page: 1, textLayer: true, rows: 13, cols: 5, note: "電子檔：經費明細表" },
  { page: 2, textLayer: false, rows: 13, cols: 5, note: "掃描頁：同一張表的圖" },
  { page: 3, textLayer: true, rows: 20, cols: 3, note: "電子檔：資產負債表" },
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const fails = [];

  await page.goto(BASE, { waitUntil: "load" });
  // 等頁面程式跑完再開始（腳本在 body 末端，元素出現時函式可能還沒定義）
  await page.waitForFunction(() => typeof renderPdfPage === "function" && typeof loadFile === "function",
    undefined, { timeout: 60000 });
  await page.waitForSelector("#file-input", { state: "attached" });
  await page.evaluate(() => { try { localStorage.setItem("pcAutoAnalyze", "1"); } catch (e) {} });
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("#file-input", { state: "attached" });

  await page.setInputFiles("#file-input", PDF);
  await page.waitForFunction(() => document.querySelectorAll("#data-table tbody tr").length > 0, undefined, { timeout: 300000 });

  const readState = () => page.evaluate(() => ({
    rows: (typeof tableData !== "undefined" ? tableData.length : 0),
    cols: (typeof tableData !== "undefined" && tableData.length) ? Math.max(...tableData.map((r) => r.length)) : 0,
    summary: (document.getElementById("summary") || {}).innerText || "",
    pageInfo: (document.getElementById("pdf-page-info") || {}).textContent || "",
  }));

  const clearResults = () => page.evaluate(() => {
    document.getElementById("summary").innerHTML = "";
    const t = document.getElementById("data-table");
    if (t) t.innerHTML = "";
  });

  const check = async (pageNo, prev) => {
    const want = EXPECT.find((e) => e.page === pageNo);
    // 換頁要等「這一頁的結果出來」：頁碼正確 + 摘要出現來源判斷
    // （用「摘要變了」會撞到換頁途中短暫的「選取已重置」，測到上一頁的狀態）
    await page.waitForFunction((n) => {
      const info = (document.getElementById("pdf-page-info") || {}).textContent || "";
      const summary = (document.getElementById("summary") || {}).innerText || "";
      return info.includes(`第 ${n} /`) && /PDF 文字層|掃描影像|解析度太低或太模糊/.test(summary);
    }, pageNo, { timeout: 300000 }).catch(() => {});
    await page.waitForTimeout(800);
    const st = await readState();
    const isText = /PDF 文字層/.test(st.summary);
    const isScan = /掃描影像/.test(st.summary) || /解析度太低或太模糊/.test(st.summary);
    const ok = (want.textLayer ? isText : isScan) && st.rows === want.rows && st.cols === want.cols;
    if (!ok) fails.push(`第 ${pageNo} 頁（${want.note}）：期望 ${want.rows}×${want.cols}${want.textLayer ? "、文字層" : "、掃描頁"}，`
      + `實際 ${st.rows}×${st.cols}${isText ? "、文字層" : isScan ? "、掃描頁" : "、判斷不出來源"}`);
    console.log(`${ok ? "PASS" : "FAIL"}  第 ${pageNo} 頁 ${want.note}  ${st.rows}×${st.cols}  `
      + `${isText ? "文字層" : isScan ? "掃描頁(OCR)" : "?"}  ${st.pageInfo}`);
    return st;
  };

  let st = await readState();
  st = await check(1, { rows: -1, summary: "" });
  for (const no of [2, 3, 1]) {
    await clearResults();
    await page.evaluate((n) => renderPdfPage(n), no);
    const before = st;
    st = await check(no, before);
  }

  await browser.close();
  if (fails.length) {
    console.log("\n失敗：\n" + fails.map((f) => "  - " + f).join("\n"));
    process.exit(1);
  }
  console.log("\n全部通過：文字頁／掃描頁逐頁判斷正確，來回換頁也正確。");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
