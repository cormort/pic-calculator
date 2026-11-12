/* 批次流程的回歸測試（Playwright，需要 OCR 模型，約 1–2 分鐘）。
 *
 * 驗的是「一次選多張 → 逐張辨識 → 狀態晶片 → 換來換去不亂 → 批次總表 / CSV」，
 * 這一段的狀態很多（佇列、每張結果快照、狀態結算時機），只有真的跑一次才抓得到。
 *
 * 用法：
 *   python3 -m http.server 8765 --bind 127.0.0.1 --directory pic-calculator/static &
 *   node bench/check_batch.js
 *   node bench/check_batch.js --base=https://cormort.github.io/pic-calculator/
 */
const path = require("path");
const { chromium } = require("playwright");

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const BASE = arg("base", "http://127.0.0.1:8765/");
const SHOTS = path.join(__dirname, "shots");

// 期望：第 2 張（資產負債表）的合計本來就對不上（測試圖自己裁過列），所以是 ❌
const CASES = [
  { file: "a-clean.png", rows: 13, cols: 5, status: "ok" },
  { file: "d-balance.png", rows: 20, cols: 3, status: "bad" },
  { file: "c-lowres.jpg", rows: 13, cols: 5, status: "ok" },
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const fails = [];
  const waitApp = () => page.waitForFunction(
    () => typeof handleFiles === "function" && typeof batchJump === "function", undefined, { timeout: 60000 });

  // 注意：GitHub Pages 的根網址是 meta refresh 轉址，載入後還會再導一次；
  // 先等到應用程式真的跑起來，再去碰 localStorage（否則 evaluate 會撞到導航）
  await page.goto(BASE, { waitUntil: "load" });
  await waitApp();
  await page.evaluate(() => { try { localStorage.setItem("pcAutoAnalyze", "1"); } catch (e) {} });
  await page.reload({ waitUntil: "load" });
  await waitApp();

  // 一次丟三張
  await page.setInputFiles("#file-input", CASES.map((c) => path.join(SHOTS, c.file)));
  await page.waitForFunction(() => document.querySelectorAll("#batch-chips .chip").length === 3,
    undefined, { timeout: 60000 }).catch(() => {});

  for (let i = 0; i < CASES.length; i++) {
    if (i > 0) await page.evaluate((n) => batchJump(n), i);
    const want = CASES[i];
    await page.waitForFunction(([n, r, c]) => {
      const b = batch[n];
      return b && b.status !== "pending" && tableData.length === r
        && Math.max(...tableData.map((x) => x.length)) === c;
    }, [i, want.rows, want.cols], { timeout: 300000 }).catch(() => {});
    const st = await page.evaluate((n) => ({
      idx: batchIndex,
      n: batch.length,
      status: batch[n] && batch[n].status,
      rows: tableData.length,
      cols: tableData.length ? Math.max(...tableData.map((r) => r.length)) : 0,
      chips: [...document.querySelectorAll("#batch-chips .chip")].map((c) => c.textContent.trim()),
    }), i);
    const problems = [];
    if (st.n !== 3) problems.push(`佇列 ${st.n} 張（期望 3）`);
    if (st.idx !== i) problems.push(`目前第 ${st.idx + 1} 張（期望第 ${i + 1}）`);
    if (st.rows !== want.rows || st.cols !== want.cols) problems.push(`欄列 ${st.rows}×${st.cols}（期望 ${want.rows}×${want.cols}）`);
    if (st.status !== want.status) problems.push(`狀態 ${st.status}（期望 ${want.status}）`);
    const ok = problems.length === 0;
    console.log(`${ok ? "PASS" : "FAIL"}  第 ${i + 1} 張 ${want.file.padEnd(16)} ${st.rows}×${st.cols} 狀態 ${st.status}`
      + `  晶片 ${st.chips.join(" ")}`);
    if (!ok) fails.push(`第 ${i + 1} 張 ${want.file}：${problems.join("；")}`);
  }

  // 跳回第 1 張：結果與狀態都要還在
  await page.evaluate(() => batchJump(0));
  await page.waitForFunction(() => batchIndex === 0 && tableData.length === 13, undefined, { timeout: 60000 }).catch(() => {});
  const back = await page.evaluate(() => ({
    rows: tableData.length,
    summary: (document.getElementById("summary").innerText || "").replace(/\s+/g, " "),
    status: batch[0].status,
  }));
  const backOk = back.rows === 13 && back.status === "ok" && /批次第 1 \/ 3 張/.test(back.summary);
  console.log(`${backOk ? "PASS" : "FAIL"}  跳回第 1 張（結果與狀態還原）  ${back.rows} 列 ${back.status}`);
  if (!backOk) fails.push(`跳回第 1 張：rows=${back.rows}、status=${back.status}、summary=${back.summary.slice(0, 40)}`);

  // 批次總表 + CSV
  const summary = await page.evaluate(() => {
    toggleBatchSummary(true);
    const rows = [...document.querySelectorAll("#batch-summary-body tbody tr")]
      .map((tr) => [...tr.querySelectorAll("td")].map((td) => td.innerText.trim()));
    return { rows, csv: batchCsvText(), text: document.getElementById("batch-summary-body").innerText };
  });
  const t = summary.text.replace(/\s+/g, " ");
  const badRow = summary.rows.find((r) => r[1] === "d-balance.png") || [];
  const okRow = summary.rows.find((r) => r[1] === "a-clean.png") || [];
  const checks = [
    [summary.rows.length === 3, `總表 ${summary.rows.length} 列（期望 3）`],
    [/✅ 2/.test(t) && /❌ 1/.test(t), `總表統計：${t.slice(0, 40)}`],
    [badRow[2] === "❌" && Number(badRow[7].replace(/,/g, "")) > 0, `d-balance 差異總額「${badRow[7]}」`],
    [okRow[9] === "0", `a-clean 看不懂的數字格「${okRow[9]}」（期望 0，文字標籤不該被誤報）`],
    [/^#?,?檔名/.test(summary.csv.split("\n")[0].replace(/^\ufeff/, "")) && summary.csv.split("\n").length === 4,
      `CSV 標頭/列數：${summary.csv.split("\n").length} 行`],
    [/有問題/.test(summary.csv) && /驗算通過/.test(summary.csv), "CSV 狀態欄"],
  ];
  for (const [ok, msg] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
    if (!ok) fails.push(msg.replace(/：.*/, ""));
  }

  await browser.close();
  if (fails.length) {
    console.log("\n失敗：\n" + fails.map((f) => "  - " + f).join("\n"));
    process.exit(1);
  }
  console.log("\n全部通過：批次佇列、狀態結算、換張還原、總表與 CSV。");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
