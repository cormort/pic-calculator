#!/usr/bin/env python3
"""SLANet 原型（2026-11-12）：確認「表格結構模型」接不接得上，結論是**現成 ONNX 不行**。

用法（需要 onnxruntime；模型自己抓）：
  pip install onnxruntime pillow numpy
  curl -L -o slanet_1m.onnx https://huggingface.co/bdatdo0601/slanet-1m-onnx/resolve/main/slanet_1m.onnx
  python bench/experiments/slanet_probe.py ../pic-calc/bench/shots/a-clean.png

量測結果：
- bdatdo0601/slanet-1m-onnx（7.7MB, MIT）：1600×1143 的表（13 列 × 5 欄 ＝ 65 格）
  只吐出 15 個 `<td>`，而且每列被當成「一欄」；換 BGR/RGB、精確縮放、0–255 正規化
  四種預處理都一樣。看起來是匯出的模型與文件的預處理不一致。
- jingsongliu/onnxocr_model 的 slanet-plus.onnx：輸出 8 個座標／50 類別，
  但同一組預處理解碼出來是 `</td></thead><tbody>` 這種不合法的開頭，猜測 vocab 對不上。

結論：要做這條路，得自己轉 PaddleOCR 官方的模型，而不是拿現成 ONNX 硬接。

## 第二次嘗試：自己轉（2026-11-12，同樣沒成功，但卡點換了）

環境：Python 3.11（3.14 裝不了 paddle）＋ paddlepaddle 3.3.1 ＋ paddle2onnx 2.1.0。
模型：官方 `ch_ppstructure_mobile_v2.0_SLANet_infer.tar`
（https://paddleocr.bj.bcebos.com/ppstructure/models/slanet/ch_ppstructure_mobile_v2.0_SLANet_infer.tar）

```bash
python3.11 -m venv .venv-paddle
.venv-paddle/bin/pip install paddlepaddle paddle2onnx onnx packaging
.venv-paddle/bin/paddle2onnx --model_dir ch_ppstructure_mobile_v2.0_SLANet_infer \
  --model_filename inference.pdmodel --params_filename inference.pdiparams \
  --save_file slanet_official.onnx --opset_version 16
```

轉檔「成功」（7.7MB），但 **onnxruntime 載不進來**：

```
Node (Concat.27) Op (Concat) [ShapeInferenceError] axis must be in [-rank, rank-1]
```

追進去看，paddle2onnx 為了支援動態形狀，把形狀運算翻成 `Slice(Shape) → Squeeze → Cast → Concat`
的純量鏈，ORT 不接受「純量 Concat」（`Cannot concatenate scalars`）。縮放器也只能部分折疊。

下一步（還沒做）三選一：
1. 把輸入固定成 [1,3,488,488] 後做 ONNX 圖手術：把那幾個純量 Concat 換成常數（形狀既定，值算得出來）
2. 改用 Paddle 3.x 原生 `paddle.onnx.export`（動態圖 export）而不是 paddle2onnx
3. 換成離線轉檔（Linux + 較舊的 paddle2onnx 1.0.x，社群回報 SLANet 可用）

驗收方式已備好：先拿 `/tmp/thick_table.png`（3×4 粗線表）確認解出 15 格，再跑
`bench/probe/g-borderless.png`。在「粗線 3×4 都解不出 15 格」之前，不要接進 App。
"""
import sys
import numpy as np
import onnxruntime as ort
from PIL import Image

DICT = ['<thead>', '<tr>', '<td>', '</td>', '</tr>', '</thead>', '<tbody>', '</tbody>',
        '<td', ' colspan="5"', '>', ' colspan="2"', ' colspan="3"', ' rowspan="2"',
        ' colspan="4"', ' colspan="6"', ' rowspan="3"', ' colspan="9"', ' colspan="10"',
        ' colspan="7"', ' rowspan="4"', ' rowspan="5"', ' rowspan="9"', ' colspan="8"',
        ' rowspan="8"', ' rowspan="6"', ' rowspan="7"', ' rowspan="10"', 'sos', 'eos']
TD_TOKENS = {"<td>", "<td"}


def preprocess(path, max_len=488):
    img = Image.open(path).convert("RGB")
    # PaddleOCR 預設讀成 BGR；onnx 模型是以 BGR 訓練的
    bgr = np.array(img)[:, :, ::-1]
    h, w = bgr.shape[:2]
    ratio = max_len / max(h, w)
    rh, rw = max(1, int(round(h * ratio))), max(1, int(round(w * ratio)))
    resized = np.array(Image.fromarray(bgr).resize((rw, rh), Image.BICUBIC), dtype=np.float32)
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    norm = (resized / 255.0 - mean) / std
    padded = np.zeros((max_len, max_len, 3), dtype=np.float32)
    padded[:rh, :rw] = norm
    chw = padded.transpose(2, 0, 1)[None]
    return chw.astype(np.float32), (h, w, ratio)


def decode(bbox_preds, struct_probs):
    """回傳 cells: [{bbox(0..1000), colspan, rowspan}]"""
    idx = struct_probs[0].argmax(-1)
    cells, cur = [], None
    for step, t in enumerate(idx):
        ch = DICT[t] if 0 <= t < len(DICT) else "eos"
        if ch == "eos":
            break
        if ch == "sos":      # 座標佔位符：每個 <td> 後面會跟 4 個
            continue
        if ch in TD_TOKENS:
            if cur:
                cells.append(cur)
            cur = {"bbox": bbox_preds[0][step].tolist(), "colspan": 1, "rowspan": 1}
            continue
        if cur and ch.startswith(" colspan="):
            cur["colspan"] = int(ch.split('"')[1])
        elif cur and ch.startswith(" rowspan="):
            cur["rowspan"] = int(ch.split('"')[1])
        elif ch == "</td>" and cur:
            cells.append(cur)
            cur = None
    if cur:
        cells.append(cur)
    return cells


def cluster(values, tol):
    """把座標分群成格線位置"""
    vals = sorted(values)
    groups = []
    for v in vals:
        if groups and v - groups[-1][-1] <= tol:
            groups[-1].append(v)
        else:
            groups.append([v])
    return [sum(g) / len(g) for g in groups]


def build_grid(cells, img_w, img_h, tol=12):
    """把 cell bbox（0..1000）換成行列索引"""
    if not cells:
        return [], []
    xs, ys = [], []
    for c in cells:
        x1, y1, x2, y2 = c["bbox"]
        xs += [min(x1, x2), max(x1, x2)]
        ys += [min(y1, y2), max(y1, y2)]
    col_edges = cluster(xs, tol)
    row_edges = cluster(ys, tol)

    def band(edges, lo, hi):
        lo_i = min(range(len(edges)), key=lambda i: abs(edges[i] - lo))
        hi_i = min(range(len(edges)), key=lambda i: abs(edges[i] - hi))
        return lo_i, max(lo_i + 1, hi_i)

    grid_cells = []
    for c in cells:
        x1, y1, x2, y2 = c["bbox"]
        r0, r1 = band(row_edges, min(y1, y2), max(y1, y2))
        c0, c1 = band(col_edges, min(x1, x2), max(x1, x2))
        grid_cells.append({
            "r0": r0, "r1": r1, "c0": c0, "c1": c1,
            "x1": min(x1, x2) / 1000 * img_w, "x2": max(x1, x2) / 1000 * img_w,
            "y1": min(y1, y2) / 1000 * img_h, "y2": max(y1, y2) / 1000 * img_h,
        })
    nrow = max(c["r1"] for c in grid_cells) if grid_cells else 0
    ncol = max(c["c1"] for c in grid_cells) if grid_cells else 0
    return grid_cells, (nrow, ncol)


def main():
    sess = ort.InferenceSession("slanet/slanet_1m.onnx", providers=["CPUExecutionProvider"])
    for path in sys.argv[1:]:
        x, (h, w, ratio) = preprocess(path)
        outs = sess.run(None, {"x": x})
        # 輸出順序：bbox_preds (T,4)、structure logits (T,30)
        bbox_preds, struct_probs = outs
        cells = decode(bbox_preds, struct_probs)
        grid, (nrow, ncol) = build_grid(cells, w, h)
        print(f"\n== {path}  模型輸入 {x.shape}（原圖 {w}x{h}, ratio {ratio:.3f}）")
        print(f"   解出 {len(cells)} 格，行列數 {nrow}x{ncol}")
        for c in grid[:14]:
            print(f"   r{c['r0']}-{c['r1']} c{c['c0']}-{c['c1']}  "
                  f"x[{c['x1']:.0f},{c['x2']:.0f}] y[{c['y1']:.0f},{c['y2']:.0f}]")


if __name__ == "__main__":
    main()
