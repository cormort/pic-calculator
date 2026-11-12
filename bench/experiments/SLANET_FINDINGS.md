# SLANet（表格結構模型）轉 ONNX：實測結論

> 一句話：**可以用了。** 用 `paddlepaddle==2.6.2 + paddle2onnx==1.0.8`（Python 3.11，Linux x86_64）在
> GitHub Actions 轉出來的 `slanet_plus.onnx`（7.4 MB，sha256 `5c17c886…`）在**真瀏覽器的
> onnxruntime-web 1.31.1** 上載得進來、跑得動、也認得表格結構。已放進
> `pic-calculator/static/models/slanet_plus.onnx`。

## 一、原本的判斷錯在哪裡

先前的結論是「轉出來的圖含 `Loop`，所以 onnxruntime-web 會拒絕」。實測不是這樣：

| 模型 | 圖上有 Loop | onnxruntime-web 1.31.1 | 桌機 onnxruntime |
|---|---|---|---|
| paddle2onnx **1.0.8**（py3.10 / py3.11 產物位元組完全相同） | 有（1 個） | **載入 304 ms、推論 310 ms、解出 15 / 20 格** | 正常 |
| paddle2onnx **2.1.0**（paddle 3.0.0） | 有 | 建立 session 就失敗：`ShapeInferenceError: axis must be in [-rank, rank-1]`（`Concat.27`） | 同樣失敗 |

也就是說：**Loop 不是問題，2.1.0 轉出無效的 `Concat` 才是問題。** 舊腳本把「圖上有 Loop」
當成失敗條件，等於把唯一能用的那顆模型判死。

Loop 的內容也順便看了（`~/.hermes/cache/scratch/inspect_loop.py`）：body 是解碼器的自回歸
循環（GRU + ArgMax + OneHot + ScatterElements，195 個節點；trip count 是常數、條件來自 `Less`），
是 SLANet 本身的結構，不是轉檔工具亂加的 —— 換版本也消不掉。

## 二、版本為什麼會挑錯（wheel 矩陣）

CI 第一次失敗的真正原因不是轉檔，是**根本裝不起來**：

| 套件 | 有 wheel 的 Python 版本 | 2026-11-12 實測 |
|---|---|---|
| `paddle2onnx==1.0.6` | cp36–cp310（**沒有 cp311**） | py3.11 → `No matching distribution` |
| `paddle2onnx==1.0.9` | cp36–cp310 | 同上 |
| `paddle2onnx==1.0.5` | cp36–cp311，但 **cp311 只有 aarch64** | x86_64 py3.11 → `No matching distribution` |
| `paddle2onnx==1.0.8` | cp310 / cp311（x86_64 manylinux） | ✅ 可用 |
| `paddle2onnx==2.1.0` | cp38–cp312（含 aarch64） | 裝得起來，但轉出來不合法 |
| `paddlepaddle==2.6.2` | cp38–cp312（含 aarch64 manylinux） | 需要 `six`，否則 `import paddle` 就 `ModuleNotFoundError` |
| `paddlepaddle==3.0.0` | cp38–cp313 | 需要 `setuptools`（`pkg_resources`） |

另外 CI 有兩個「看起來成功其實沒做事」的坑，都已修：

1. `python convert_slanet.py | tee convert.log` —— 管線結束碼是 `tee` 的 0，轉檔失敗照樣綠燈，
   上傳步驟才說「找不到 `slanet_plus_*.onnx`」。加 `set -o pipefail`。
2. `check_web_safe()` 只印 `WARN` 就 `exit 0`，含 Loop 的圖會被當成通過。改成真的判失敗
   （現在則改成「只回報、不判死」，理由見上）。

## 三、在三種環境跑過的結果

| 環境 | 架構 | 結果 |
|---|---|---|
| macOS（本機，paddle2onnx 2.1.0） | arm64 | ❌ 無效 `Concat`，連桌機 onnxruntime 都載不進來 |
| GitHub Actions `ubuntu-latest`（1.0.8 + py3.10 / py3.11） | x86_64 | ✅ 兩組產物**位元組相同**，格數 15 / 20 全過 |
| Oracle Always Free VM（Osaka，Ubuntu 24.04） | aarch64 | ⚠️ 理論可行但不划算：`paddle2onnx 1.0.x` 只有 `1.0.5` 有 aarch64 且僅 cp311，Ubuntu 24.04 內建 3.12 → 得額外裝 py3.11；1 核轉檔慢，且 `1.0.5` 沒有 x86_64 py3.11 版可對照 |
| Google Colab | x86_64 | ✅ 與 GitHub Actions 同一組 wheel（`bench/experiments/slanet_convert_colab.ipynb`，依 Python 版本自動挑 paddle2onnx） |

## 四、瀏覽器端到端實測（真正的驗收）

`~/pic-calc-bench/verify_slanet_browser.js`（ego-browser，App 用的同一個 ort 1.31.1）：

```
vocab=50  createMs=304
PASS  3×4：解出 15 格（期望 15） 314ms  tokens: <tbody> <tr> <td></td> <td></td> <td></td> ...
PASS  4×4：解出 20 格（期望 20） 310ms  tokens: <tbody> <tr> <td></td> <td></td> <td></td> <td></td> ...
```

- 建立 session：304 ms（WASM）
- 單張 488×488 推論：**310–314 ms** —— 與 PP-OCR 的 4–6 秒相比幾乎免費
- 解出的 token 序列是合法的 `<tbody><tr><td></td>…`，格數與期望一致

## 五、下一步（尚未做）

1. **接進 worker**：`models/slanet_plus.onnx` 已就位，但 `ocr-worker.js` 還沒有「結構模式」；
   要新增一路：把轉正後的圖 → 488×488 前處理 → SLANet → cell 座標＋HTML 結構 → 取代目前
   靠格線切欄的 `splitStraddling()`。這是解決「合併儲存格、複雜表頭」那類問題的正解。
2. 對 real photo（斜拍、模糊）量一次格數正確率，確認不是只在合成圖上好看。
3. 7.4 MB 模型檔進 repo：Pages 首次載入會變慢，接線時應改成「需要結構模式才下載」並用
   service worker 快取。

## 六、怎麼重跑

```bash
# GitHub Actions（建議，x86_64、有 artifact）
gh workflow run slanet-convert   # 或 API：POST /actions/workflows/slanet-convert.yml/dispatches
# Colab
# 開 bench/experiments/slanet_convert_colab.ipynb → Run all → 自動下載 ONNX
# 本機 Linux
WORKDIR=~/slanet ./bench/experiments/slanet_convert_standalone.sh
```
