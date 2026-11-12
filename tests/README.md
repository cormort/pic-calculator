# 前端測試（不需要瀏覽器或 OCR 模型）

```bash
node tests/test_build_table.js   # 空白帶切欄、每格信心、Shift 連續選取
node tests/test_smart_totals.js  # 智慧合計候選算法與 OCR 標籤修正
node tests/test_template.js      # 沿用上一張的驗算設定
```

測試會直接從 `pic-calculator/static/index.html` 抽出純函式，
再搭配 `pic-calculator/static/smart_total.js` 執行。
