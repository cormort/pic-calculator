/* 貼上文字／表格的解析回歸測試（Playwright，不需要 OCR 模型，約 15 秒）。
 *
 * 驗四種常見格式 + 單欄金額，以及「貼上後有沒有接上既有的驗算流程」：
 *   1. TSV（Excel／Google 試算表整塊複製）
 *   2. CSV（含千分位逗號不能誤切）
 *   3. 連續空白／全形空白對齊（Word、PDF 複製）
 *   4. 一行一筆「項目 金額」（含全形冒號）
 *   5. 單欄金額（純數字堆疊）→ 沒有合計列，應該提示「尚未驗算」而不是報錯
 *
 * 用法：
 *   python3 -m http.server 8765 --bind 127.0.0.1 --directory pic-calculator/static &
 *   node bench/check_paste.js
 *   node bench/check_paste.js --base=https://cormort.github.io/pic-calculator/
 */
const { chromium } = require("playwright");

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const BASE = arg("base", "http://127.0.0.1:8765/");

const CASES = [
  {
    name: "TSV（試算表複製）",
    text: "項次\t會計科目\t金額\n1\t人事費\t548,000\n2\t業務費\t361,731\n合計\t\t909,731",
    shape: [4, 3],
    first: ["項次", "會計科目", "金額"],
    smart: /相符/,
  },
  {
    name: "CSV（千分位逗號不能誤切）",
    text: "科目,金額\n租金,12000\n水電,3500\n合計,15500",
    shape: [4, 2],
    first: ["科目", "金額"],
    cell: [1, 1, "12,000"],       // 12000 → 12,000 自動整理
    smart: /相符/,
  },
  {
    name: "空白對齊（Word／PDF 複製）",
    text: "科目    金額\n租金    12,000\n水電     3,500\n合計    15,500",
    shape: [4, 2],
    first: ["科目", "金額"],
    cell: [3, 1, "15,500"],
    smart: /相符/,
  },
  {
    name: "一行一筆（含全形冒號）",
    text: "租金 12,000\n水電：3,500\n合計 15,500",
    shape: [3, 2],
    first: ["租金", "12,000"],
    cell: [1, 0, "水電"],
    smart: /相符/,
  },
  {
    name: "單欄金額（沒有合計列）",
    text: "12,000\n3,500\n8,250",
    shape: [3, 1],
    first: ["12,000"],
    smart: /尚未驗算/,
  },
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.goto(BASE, { waitUntil: "load" });
  // 等「頁面的程式真的跑完」：腳本在 body 末端，#paste-input 出現時函式可能還沒定義
  await page.waitForFunction(() => typeof applyPastedText === "function" && typeof tableData !== "undefined",
    undefined, { timeout: 60000 });

  const fails = [];
  for (const c of CASES) {
    const st = await page.evaluate((text) => {
      document.getElementById("paste-input").value = text;
      applyPastedText();
      return {
        rows: tableData.length,
        cols: tableData.length ? Math.max(...tableData.map((r) => r.length)) : 0,
        first: (tableData[0] || []).slice(),
        smart: (document.getElementById("smart-note") || {}).innerText || "",
        summary: (document.getElementById("summary") || {}).innerText || "",
        cell: null,
      };
    }, c.text);

    const problems = [];
    if (st.rows !== c.shape[0] || st.cols !== c.shape[1]) {
      problems.push(`欄列數 ${st.rows}×${st.cols}（期望 ${c.shape[0]}×${c.shape[1]}）`);
    }
    if (c.first && JSON.stringify(st.first.slice(0, c.first.length)) !== JSON.stringify(c.first)) {
      problems.push(`第一列 ${JSON.stringify(st.first)}（期望 ${JSON.stringify(c.first)}）`);
    }
    if (c.cell) {
      const [r, col, want] = c.cell;
      const got = await page.evaluate(([rr, cc]) => (tableData[rr] || [])[cc], [r, col]);
      if (got !== want) problems.push(`第 ${r + 1} 列第 ${col + 1} 欄「${got}」（期望「${want}」）`);
    }
    if (c.smart && !c.smart.test(st.smart + st.summary)) {
      problems.push(`驗算結果不符：${(st.smart || st.summary).slice(0, 40)}`);
    }
    const ok = problems.length === 0;
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.name.padEnd(22)} ${st.rows}×${st.cols}`
      + `  ${(st.smart || st.summary).replace(/\s+/g, " ").slice(0, 34)}`);
    if (!ok) fails.push(`${c.name}：${problems.join("；")}`);
  }

  // 走一次真正的 UI 路徑（按鈕 → 面板 → 解析），確保不是只有函式能用
  const ui = await page.evaluate(() => {
    togglePastePanel(true);
    document.getElementById("paste-input").value = "科目\t金額\n租金\t12,000\n水電\t3,500\n合計\t15,500";
    document.querySelector('#paste-panel button.btn').click();   // 「解析並驗算」
    return {
      panelHidden: document.getElementById("paste-panel").style.display === "none",
      rows: tableData.length,
    };
  });
  const uiOk = ui.panelHidden && ui.rows === 4;
  console.log(`${uiOk ? "PASS" : "FAIL"}  UI 路徑（按鈕解析後收起面板）  ${ui.rows} 列`);
  if (!uiOk) fails.push(`UI 路徑：面板 hidden=${ui.panelHidden}、rows=${ui.rows}`);

  await browser.close();
  if (fails.length) {
    console.log("\n失敗：\n" + fails.map((f) => "  - " + f).join("\n"));
    process.exit(1);
  }
  console.log("\n全部通過：四種分隔格式＋單欄金額＋UI 路徑。");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
