#!/usr/bin/env python3
"""SLANet 表格結構模型：能不能接進這個 App？（2026-11-12 調查）

## 結論摘要

1. **模型本身可以做到**：用 PaddleOCR 官方 `TableLabelDecode`（merge_no_span_structure=True）
   解碼，3×4／4×4 的合成表完全正確（20/20 格）。
2. **我前兩輪的「模型壞了」判斷是錯的**：不是模型的問題，是字典對錯了 ——
   官方的字典建構會把 `<td>` 換成 `<td></td>`、並在最前後加 `sos`／`eos`，
   我拿原始 `table_structure_dict_ch.txt`（含 `<td>`）直接對索引，難怪解出亂碼。
3. **真正的卡點在瀏覽器**：可用的 ONNX 版本裡面有一個 `Loop` 子圖（paddle2onnx 為了動態形狀
   產生的），onnxruntime-web 在建立 session 時就拒絕：
   `[ShapeInferenceError] Mismatch between number of inferred and declared dimensions (inferred=1 declared=0)`。
   桌機版 ORT 只印警告、照樣載入；web 版直接失敗。

## 已驗證可用的部分

```bash
python3.11 -m venv .venv-paddle
.venv-paddle/bin/pip install paddlepaddle paddle2onnx onnx onnxruntime packaging

# 官方模型（Paddle 格式）
curl -L -o model.tar https://paddleocr.bj.bcebos.com/ppstructure/models/slanet/ch_ppstructure_mobile_v2.0_SLANet_infer.tar
tar -xf model.tar
```

用 Paddle 直接跑（`FLAGS_enable_pir_api=0`，因為 Paddle 3.x 的 PIR 讀不了舊格式）：

```python
paddle.enable_static(); paddle.set_flags({"FLAGS_enable_pir_api": False})
exe = paddle.static.Executor(paddle.CPUPlace())
prog, _, fetches = paddle.static.load_inference_model(prefix, exe)
loc, st = exe.run(prog, feed={"x": img_488}, fetch_list=fetches)   # (1,T,8) / (1,T,50)
```

再用官方 `ppocr/postprocess/table_postprocess.py` 的 `TableLabelDecode.decode(st, loc, [shape_list])`
解碼 → 3×4 合成表 20 格、a-clean 79 格（多切是因為圖上有標題列，模型把它當一列）。

## 卡點與走法

要進瀏覽器就得有「onnxruntime-web 載得進來」的 ONNX。試過都失敗：

| 來源 / 作法 | 結果 |
|---|---|
| HF `jingsongliu/onnxocr_model` 的 `slanet-plus.onnx`（7.7MB） | 桌機可跑、**web 載入失敗**（Loop 子圖形狀推論不一致） |
| HF `bdatdo0601/slanet-1m-onnx` | 解碼出來只有 1 格 → 匯出有問題 |
| 自己用 paddle2onnx 2.1.0 轉官方模型 | 轉出 7.7MB，但圖內有「純量 Concat」，桌機/web 都載不進來 |
| 清 value_info／output shape、onnxsim 簡化、改 opset、關最佳化、換 ORT 1.20/1.22 | 同一個 ShapeInferenceError（或 wasm 載入失敗） |

可行的下一步（依成本排序）：

1. **把 Loop 拿掉**：這個 Loop 是動態形狀的產物，輸入固定 488×488 時理論上可以展開或替換成常數。
   需要 ONNX 圖手術（把 Loop 的 body 依固定次數展開）。
2. **在 Linux/CI 用舊版 paddle2onnx（1.0.x）轉**：社群回報 SLANet 系列可以轉出乾淨的圖。
3. **伺服器端跑**：RapidTable／PaddleOCR 在後端出結構，前端只收結果 —— 但這會打破
   「純前端、不上傳」的架構，要另外評估。

驗收門檻（不要跳過）：先在 3×4 粗線合成表上解出 15 格、4×4 方表解出 20 格，
再跑 `bench/probe/g-borderless.png`（目前 23.1%／數字 0%）。

## 附註

- 判讀結構 token 時別忘了：`sos` 是座標佔位符（每個 `<td>` 後面跟 4 個），要跳過；
  `eos` 才是結束。
- 這次的整合程式（worker 端解碼＋把字框塞進格子）已寫過一版、但因上面第 3 點而回退，
  需要的話可以從 git 記錄找回來。
