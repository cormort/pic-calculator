/* 用真實瀏覽器跑完整 OCR 管線，量測 6 張中文表格測試圖的格級正確率。
 *
 * 需要 Playwright + Chromium（CI 用 `npx playwright install --with-deps chromium`）。
 * 模型（30MB／139MB）由 CDN 下載，第一次跑要等一下。
 *
 * 用法：
 *   node bench/run_ocr.js                          # 小模型，本機 127.0.0.1:8765
 *   node bench/run_ocr.js --quality=medium         # 高精度模型
 *   node bench/run_ocr.js --base=http://127.0.0.1:8765/ --out=out/run.json
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const ROOT = path.join(__dirname, "..");
const SET = arg("set", "main");            // main＝正式基準；probe＝已知缺口的觀察用
const SHOTS = path.join(__dirname, SET === "probe" ? "probe/shots" : "shots");
const FIXTURES = SET === "probe"
  ? ["g-borderless.png", "h-title-row.png"]
  : ["a-clean.png", "b-photo.jpg", "c-lowres.jpg", "d-balance.png", "e-balance-photo.jpg", "f-tilted.jpg"];
const BASE = arg("base", "http://127.0.0.1:8765/");
const QUALITY = arg("quality", "small");
const OUT = path.join(ROOT, arg("out", "out/run.json"));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const results = [];

  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#file-input", { state: "attached" });
  // 關掉「選圖後自動辨識」，改成自己按鈕，量測時間與流程才固定
  await page.evaluate((q) => {
    try { localStorage.setItem("pcAutoAnalyze", "0"); } catch (e) {}
    try { setOcrQuality(q); } catch (e) {}
  }, QUALITY);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("#file-input", { state: "attached" });

  for (const name of FIXTURES) {
    const t0 = Date.now();
    await page.evaluate(() => {
      if (typeof resetAll === "function") resetAll();
      const ws = document.getElementById("workspace");
      if (ws) ws.style.display = "none";
    });
    const prevLen = await page.evaluate(() => (document.getElementById("preview-img").src || "").length);
    await page.setInputFiles("#file-input", path.join(SHOTS, name));
    await page.waitForFunction(
      (n) => (document.getElementById("preview-img").src || "").length !== n, prevLen, { timeout: 60000 });
    await page.waitForTimeout(500);
    // 直接呼叫 analyzeImage()：按鈕在「自動辨識已經跑起來」時是 disabled，用點擊會卡住
    const prev = await page.evaluate(() => (document.getElementById("summary") || {}).innerText || "");
    await page.evaluate(() => { if (typeof analyzeImage === "function") analyzeImage(); });
    // 等「摘要變了」且表格有列 —— 只看 rows>0 會抓到上一張圖留下的表格
    await page.waitForFunction((before) => {
      const summary = (document.getElementById("summary") || {}).innerText || "";
      return summary !== before && summary.length > 0
        && document.querySelectorAll("#data-table tbody tr").length > 0;
    }, prev, { timeout: 300000 });

    const dump = await page.evaluate(() => ({
      rows: [...document.querySelectorAll("#data-table tbody tr")].map((tr) =>
        [...tr.querySelectorAll("td")].slice(1).map((td) => (td.innerText || "").replace(/\u00a0/g, " ").trim())),
      conf: typeof cellConfidence !== "undefined" ? cellConfidence : null,
      ocrConfidence: typeof ocrConfidence !== "undefined" ? ocrConfidence : null,
      version: typeof APP_VERSION !== "undefined" ? APP_VERSION : null,
      summary: (document.getElementById("summary") || {}).innerText || "",
    }));
    results.push({ name, ms: Date.now() - t0, ...dump });
    console.log(`${name.padEnd(22)} ${String(dump.rows.length).padStart(2)} 列 ${(Date.now() - t0) / 1000}s  信心 ${(dump.ocrConfidence || 0).toFixed(2)}`);
  }

  await browser.close();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  console.log(`\n寫入 ${OUT}（quality=${QUALITY}）`);
  console.log("下一步：node bench/compare.js " + path.relative(ROOT, OUT));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
