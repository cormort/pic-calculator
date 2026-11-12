# 準確率量測（bench）

真 OCR 的準確率量測：用真實瀏覽器跑完整管線（版面偵測 → 透視矯正 → PP-OCR → 表格重建），
再逐格跟標準答案比對。

```bash
# 1) 啟動本機靜態檔（或用 GitHub Pages）
python3 -m http.server 8765 --bind 127.0.0.1 --directory pic-calculator/static &

# 2) 跑一輪（第一次會下載模型：標準 30MB、高精度 139MB）
npm i playwright && npx playwright install --with-deps chromium
node bench/run_ocr.js --quality=small --out=out/run.json

# 3) 比對標準答案（--strict 才會在低於基準時 exit 1）
node bench/compare.js out/run.json
```

CI 版（`.github/workflows/bench.yml`）每週跑一次，也可以手動 `workflow_dispatch`。
**非阻擋**：失敗、或低於基準超過 3 個百分點都只會出現在 job summary，不會擋 PR
（模型下載、CDN 抖動、Chromium 版本都可能讓它失敗，而準確率是數字不是布林值）。

## 測試資料

| 檔案 | 情境 |
|---|---|
| `shots/a-clean.png` | 乾淨截圖／掃描件（1600px） |
| `shots/b-photo.jpg` | 手機實拍：透視變形、陰影、模糊（3024×4032） |
| `shots/c-lowres.jpg` | 低解析度轉傳（950px、JPEG q52） |
| `shots/d-balance.png` | 資產負債表：分組列、多層合計 |
| `shots/e-balance-photo.jpg` | 同上但實拍 |
| `shots/f-tilted.jpg` | 歪斜 2.4° |

`truth/*.json` 是每張圖的標準答案（含表頭，共 380 格）。
`make_fixtures.py` 是當初怎麼做出這些圖的紀錄（Pillow + numpy）；重跑會因為雜訊、
模糊的隨機成分得到不同的圖，所以**以 shots/ 裡的檔案為準**，不要重跑覆蓋。

## 計分方式

- **格級**：標準答案的每一格 vs 對應格的文字（全形／空白正規化後比對）。
- **數字格**：只算「標準答案是數字」的格，比數值（容差 0.005）。
- **列對齊**：順序保持的動態規劃（Needleman–Wunsch）。表格列序穩定，單點對齊會因為
  一個錯字讓整列對不到、後面每列跟著位移，正確率被重複懲罰。

## 觀察用 probe（已知缺口，不列入基準）

`bench/probe/` 放的是「現在明顯做不好」的案例，用來記錄缺口、驗收未來的修正：

```bash
node bench/run_ocr.js --set=probe --out=out/probe.json
node bench/compare.js out/probe.json --set=probe
```

| 圖 | 情境 | 目前 | 說明 |
|---|---|---|---|
| `g-borderless.png` | 只有外框、沒有內部格線 | **23.1% / 數字 0%** | 沒有線就沒有欄界，切欄退回「空白帶猜測」，數字會整批跑到錯的欄。這是**歸屬錯**，不是辨識錯 |
| `h-title-row.png` | 表格上方多一列跨欄標題 | 98.5% / 100% | 標題列已能正確排除，只剩 `小計`→`小吉` 的辨識錯 |

要把 borderless 救回來，得靠「表格結構」模型（例如 PaddleOCR 的 SLANet，ONNX 約 7.7MB，
MIT 授權），而不是再調切欄規則 —— 它能直接預測「哪個字屬於哪一格」。
是否投資這一塊見 README §三。

## 目前基準

`baseline.json` 是最後一次量測的結果（標準模型）。同機重跑的變動約 ±1–2 個百分點
（OCR 對同張圖不是 100% 決定性的），所以 CI 的警戒線設在 −3 個百分點。

模型比較（同一批圖、同一台機器）：

| 模型 | 格級 | 數字格 | 每張耗時 |
|---|---|---|---|
| tiny（6MB） | 未量測 | 未量測 | — |
| **small（30MB，預設）** | **97.4%** | **97.6%** | 10–20 秒 |
| medium（139MB） | 96.3% | 93.9% | 57–117 秒 |

medium 反而比較差，而且錯法很危險：金額會掉一位（`200,000` → `2,000`、
`6,000,000` → `600`），驗算會整片紅。所以介面上標了「實測金額位數較易漏讀」。
