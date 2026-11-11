# 測試

| 指令 | 內容 | 需要模型 |
|------|------|----------|
| `.venv/bin/python tests/test_table_ocr.py -v` | 欄位對齊、EXIF 轉正、歪斜偵測（純函式） | 否 |
| `node tests/test_smart_totals.js` | 智慧合計演算法（純函式） | 否 |
| `.venv/bin/python tests/regression_ocr.py` | 三張合成圖 + 真實掃描的端到端 OCR | 是 |

`tests/fixtures/real/` 內是實際報表樣本（含敏感資料，已用 `.gitignore` 排除）。
要換成自己的測資，覆蓋 `balance-sheet-scan.png` 即可；`regression_ocr.py`
找不到檔案時會自動跳過真實樣本。

端到端測試使用 macOS 內建 Arial 產生合成表格，其他平台若沒有字型會退回
PIL 預設字型，可能影響 OCR 結果。
