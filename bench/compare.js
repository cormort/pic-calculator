/* 比對 OCR 結果與標準答案，輸出每張圖的「格級／數字格」正確率。
 *
 * 用法：
 *   node bench/compare.js [out/run.json] [--strict]
 *
 * 列對齊用「順序保持的動態規劃」（Needleman-Wunsch）。表格列序是穩定的，
 * 單點對齊會因為一個錯字讓整列對不到、後面每列跟著位移，正確率被重複懲罰。
 *
 * 預設永遠 exit 0（非阻擋）；加 --strict 才會在低於 baseline 時 exit 1。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TRUTH = path.join(__dirname, "truth");
const BASELINE = path.join(__dirname, "baseline.json");

const norm = (s) => String(s ?? "")
  .normalize("NFKC")
  .replace(/\u00a0/g, " ")
  .replace(/，/g, ",")
  .replace(/[－−]/g, "-")
  .replace(/\s+/g, "")
  .trim();

function num(s) {
  let t = norm(s);
  if (!t) return null;
  t = t.replace(/[,，$元%]/g, "");
  if (/^\(.*\)$/.test(t)) t = "-" + t.slice(1, -1);
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function labelCol(rows) {
  const ncol = rows[0].length;
  for (let c = 0; c < ncol; c++) {
    const vals = rows.slice(1).map((r) => r[c]).filter((v) => v !== undefined && String(v).trim() !== "");
    if (vals.length && vals.filter((v) => num(v) === null).length >= vals.length * 0.5) return c;
  }
  return 1;
}

function rowScore(trow, grow, colText) {
  let score = 0;
  for (let c = 0; c < trow.length; c++) {
    const tv = trow[c], gv = grow[c];
    const tn = num(tv), gn = num(gv);
    if (tn !== null && gn !== null) score += Math.abs(tn - gn) < 0.005 ? 1 : 0;
    else if (tn === null && !String(gv ?? "").trim()) score += 0.1;
  }
  const tk = norm(trow[colText]), gk = norm(grow[colText]);
  if (tk && gk) score += tk === gk ? 2 : (tk.includes(gk) || gk.includes(tk) ? 1 : 0);
  return score;
}

function align(trows, grows, colText) {
  const n = trows.length, m = grows.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const back = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(""));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = rowScore(trows[i - 1], grows[j - 1], colText);
      const diag = dp[i - 1][j - 1] + s, up = dp[i - 1][j], left = dp[i][j - 1];
      const best = Math.max(diag, up, left);
      dp[i][j] = best;
      back[i][j] = best === diag ? "d" : best === up ? "u" : "l";
    }
  }
  const pairs = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (back[i][j] === "d") {
      if (rowScore(trows[i - 1], grows[j - 1], colText) > 0) pairs.push([i - 1, j - 1]);
      i--; j--;
    } else if (back[i][j] === "u") i--;
    else j--;
  }
  return pairs.reverse();
}

function score(run) {
  const truth = JSON.parse(fs.readFileSync(path.join(TRUTH, run.name.replace(/\.(png|jpg)$/, "") + ".json"), "utf8")).rows;
  const got = run.rows.map((r) => r.map(norm));
  const col = labelCol(truth);
  const pairs = align(truth, got, col);
  const matched = new Map(pairs);
  let cells = 0, ok = 0, nums = 0, numsOk = 0;
  const misses = [];
  truth.forEach((trow, ti) => {
    const gi = matched.get(ti);
    const grow = gi === undefined ? [] : got[gi];
    trow.forEach((tv, c) => {
      const gv = grow[c] ?? "";
      const tn = num(tv), gn = num(gv);
      cells++;
      if (!String(tv).trim()) {
        if (!String(gv).trim()) ok++;
        else misses.push(`r${ti + 1}c${c + 1} 多出「${gv}」`);
        return;
      }
      if (tn !== null) {
        nums++;
        if (gn !== null && Math.abs(tn - gn) < 0.005) { numsOk++; ok++; return; }
      }
      if (norm(tv) === norm(gv)) ok++;
      else misses.push(`r${ti + 1}c${c + 1} 應「${tv}」得「${gv}」`);
    });
  });
  return { cells, ok, nums, numsOk, misses, rate: cells ? (100 * ok) / cells : 0, nrate: nums ? (100 * numsOk) / nums : 0 };
}

function main() {
  const args = process.argv.slice(2);
  const runPath = args.find((a) => !a.startsWith("--")) || path.join(ROOT, "out", "run.json");
  const strict = args.includes("--strict");
  const runs = JSON.parse(fs.readFileSync(runPath, "utf8"));
  const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")) : { fixtures: {} };

  const lines = [];
  const say = (s) => { console.log(s); lines.push(s); };
  say("| 圖 | 格級 | 數字格 | 基準（格級／數字） | 秒 |");
  say("|---|---|---|---|---|");
  let cell = 0, okCell = 0, nAll = 0, nOk = 0;
  for (const r of runs) {
    const s = score(r);
    cell += s.cells; okCell += s.ok; nAll += s.nums; nOk += s.numsOk;
    const base = baseline.fixtures[r.name];
    const bTxt = base ? `${base.cells}% / ${base.numbers}%` : "—";
    say(`| ${r.name} | ${s.rate.toFixed(1)}% | ${s.nrate.toFixed(1)}% | ${bTxt} | ${(r.ms / 1000).toFixed(1)} |`);
    if (s.misses.length) say(`| ↳ 未命中 | ${s.misses.slice(0, 4).join("；")} | | | |`);
  }
  const totalCell = (100 * okCell) / Math.max(1, cell);
  const totalNum = (100 * nOk) / Math.max(1, nAll);
  say(`| **合計** | **${totalCell.toFixed(1)}%** | **${totalNum.toFixed(1)}%** | ${baseline.total ? baseline.total.cells + "% / " + baseline.total.numbers + "%" : "—"} | |`);

  if (baseline.total) {
    const dC = totalCell - baseline.total.cells, dN = totalNum - baseline.total.numbers;
    say(`| Δ 相對基準 | ${dC >= 0 ? "+" : ""}${dC.toFixed(1)} | ${dN >= 0 ? "+" : ""}${dN.toFixed(1)} | | |`);
    // 同機重跑的變動約 ±1–2 個百分點（OCR 不是 100% 決定性的），所以警戒線設 3 點
    const regressed = dC < -3 || dN < -3;
    if (regressed) say(`\n⚠️ 低於基準超過 3 個百分點${strict ? "（--strict：失敗）" : "（非阻擋：僅提醒）"}`);
    if (regressed && strict) {
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
      process.exit(1);
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  console.log(`\n合計：格級 ${totalCell.toFixed(1)}%、數字格 ${totalNum.toFixed(1)}%（${cell} 格）`);
}

main();
