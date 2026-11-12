#!/usr/bin/env python3
"""把 PaddleOCR 官方 SLANet（表格結構模型）轉成 ONNX，並當場驗收。

為什麼需要這支腳本：本機（macOS）用 paddle2onnx 2.1 轉出來的圖含 `Loop` 子圖
（動態形狀的產物），onnxruntime-web 建立 session 時直接拒絕。這裡把「轉檔 + 驗收」
包成一支可重複執行的腳本，Linux／CI 上跑（paddle2onnx 1.0.x 轉出來的圖比較乾淨）。

用法：
  python3.11 -m venv .venv-paddle
  .venv-paddle/bin/pip install paddlepaddle paddle2onnx onnx onnxruntime pillow numpy
  .venv-paddle/bin/python bench/experiments/convert_slanet.py --out /tmp/slanet_plus.onnx

驗收門檻（沒過就不該接進 App）：
  1. 轉出來的 ONNX 能被 onnxruntime 載入（桌機版；web 版在瀏覽器另外驗）
  2. 3×4 粗線合成表 → 解出 15 格
  3. 4×4 方形合成表 → 解出 20 格

Loop／If／Scan 只回報不判死：實測 1.0.8 的圖含一個解碼器 Loop，但 onnxruntime-web
1.31.1 照樣載得進來、310 ms 跑完（見 bench/experiments/SLANET_FINDINGS.md）。

退出碼：0 全部通過、1 有項目沒過。
"""
import argparse
import os
import subprocess
import sys
import urllib.request

import numpy as np
from PIL import Image, ImageDraw

MODEL_TAR = "https://paddleocr.bj.bcebos.com/ppstructure/models/slanet/ch_ppstructure_mobile_v2.0_SLANet_infer.tar"
MODEL_DIR = "ch_ppstructure_mobile_v2.0_SLANet_infer"

# PaddleOCR 官方 table_structure_dict_ch.txt（48 行）→ 依 TableLabelDecode 的規則
# merge_no_span_structure=True：移除 `<td>`、補上 `<td></td>`，最前後加 sos／eos。
DICT_URL = "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/dict/table_structure_dict_ch.txt"


def build_vocab() -> list[str]:
    with urllib.request.urlopen(DICT_URL) as resp:
        lines = [line.rstrip("\n") for line in resp.read().decode("utf-8").splitlines() if line.strip()]
    lines = [x for x in lines if x != "<td>"]
    lines.append("<td></td>")
    return ["sos"] + lines + ["eos"]


def ensure_model(workdir: str) -> str:
    """下載並解開官方 Paddle 推論模型，回傳目錄"""
    os.makedirs(workdir, exist_ok=True)
    tar_path = os.path.join(workdir, "model.tar")
    target = os.path.join(workdir, MODEL_DIR)
    if not os.path.isdir(target):
        if not os.path.exists(tar_path):
            print(f"下載官方模型 {MODEL_TAR}")
            urllib.request.urlretrieve(MODEL_TAR, tar_path)
        subprocess.run(["tar", "-xf", tar_path, "-C", workdir], check=True)
    return target


def convert(model_dir: str, out_path: str) -> None:
    """優先用 paddle2onnx CLI；失敗再退回 Python API"""
    pdmodel = os.path.join(model_dir, "inference.pdmodel")
    pdiparams = os.path.join(model_dir, "inference.pdiparams")
    cmd = [
        sys.executable, "-m", "paddle2onnx", "--model_dir", model_dir,
        "--model_filename", "inference.pdmodel", "--params_filename", "inference.pdiparams",
        "--save_file", out_path, "--opset_version", "16",
    ]
    print("轉檔：", " ".join(cmd))
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0 or not os.path.exists(out_path):
        print(res.stdout[-800:], res.stderr[-800:])
        import paddle2onnx
        paddle2onnx.export(pdmodel, pdiparams, save_file=out_path, opset_version=16,
                           enable_onnx_checker=False)
    print("輸出：", out_path, os.path.getsize(out_path) // 1024, "KB")


def make_table(cols: int, rows: int, size: int = 800, line: int = 8) -> Image.Image:
    """粗線合成表：模型看得到格線、也知道有幾列幾欄"""
    cw = size // cols
    rh = size // (rows + 1)
    img = Image.new("RGB", (size, rh * (rows + 1)), "white")
    d = ImageDraw.Draw(img)
    for i in range(rows + 2):
        d.line([(0, i * rh), (size, i * rh)], fill="black", width=line)
    for j in range(cols + 1):
        d.line([(j * cw, 0), (j * cw, rh * (rows + 1))], fill="black", width=line)
    return img


def model_input(img: Image.Image, max_len: int = 488):
    """PaddleOCR 的預處理：BGR、長邊縮到 488、ImageNet 正規化、補到 488×488、CHW"""
    arr = np.array(img.convert("RGB")).astype(np.float32)[:, :, ::-1]
    h, w = arr.shape[:2]
    ratio = max_len / max(h, w)
    rh, rw = max(1, int(round(h * ratio))), max(1, int(round(w * ratio)))
    small = np.array(Image.fromarray(arr.astype(np.uint8)).resize((rw, rh), Image.BICUBIC), np.float32)
    mean = np.array([0.485, 0.456, 0.406], np.float32)
    std = np.array([0.229, 0.224, 0.225], np.float32)
    pad = np.zeros((max_len, max_len, 3), np.float32)
    pad[:rh, :rw] = (small / 255.0 - mean) / std
    return pad.transpose(2, 0, 1)[None], (h, w)


def decode_cells(loc: np.ndarray, probs: np.ndarray, vocab: list[str]) -> list[tuple]:
    """官方 TableLabelDecode 的簡化版：sos 是座標佔位符要跳過、<td／<td></td> 帶 8 個座標"""
    cells = []
    for t in range(probs.shape[1]):
        token = vocab[int(probs[0, t].argmax())]
        if token == "eos":
            break
        if token in ("sos",):
            continue
        if token in ("<td", "<td></td>"):
            pts = np.array(loc[0, t], dtype=np.float32).reshape(4, 2)
            cells.append(pts)
    return cells


def check_web_safe(onnx_path: str) -> tuple[bool, str]:
    """Loop／If／Scan 會讓 onnxruntime-web 在建立 session 時就失敗（實測）"""
    import onnx
    model = onnx.load(onnx_path)
    risky = [n.op_type for n in model.graph.node if n.op_type in ("Loop", "If", "Scan")]

    def walk(graph):
        out = []
        for n in graph.node:
            for a in n.attribute:
                if a.type == onnx.AttributeProto.GRAPH:
                    out += walk(a.g)
                elif a.type == onnx.AttributeProto.GRAPHS:
                    for g in a.graphs:
                        out += walk(g)
        return out
    risky += walk(model.graph)
    return (len(risky) == 0, f"圖內含 {risky}（onnxruntime-web 很可能載不進去）" if risky else "沒有 Loop/If/Scan")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="slanet_plus.onnx")
    ap.add_argument("--workdir", default="/tmp/slanet_convert")
    args = ap.parse_args()

    model_dir = ensure_model(args.workdir)
    convert(model_dir, args.out)

    import onnxruntime as ort
    try:
        sess = ort.InferenceSession(args.out, providers=["CPUExecutionProvider"])
    except Exception as err:
        print("FAIL  轉出來的 ONNX 連桌機版 onnxruntime 都載不進來：")
        print("      ", str(err)[:300])
        print("\n      這是 paddle2onnx 版本造成的（本機 macOS + paddle2onnx 2.1 會產生無效的純量 Concat，")
        print("      或含 Loop 子圖讓 onnxruntime-web 拒絕）。請改在 Linux 上用 paddle2onnx 1.0.x 重跑本腳本，")
        print("      或參考 bench/experiments/slanet_probe.py 的調查。")
        return 1
    vocab = build_vocab()
    print("vocab:", len(vocab), "類別")
    ok = True

    for cols, rows, expect in [(3, 4, 15), (4, 4, 20)]:
        img = make_table(cols, rows)
        x, _ = model_input(img)
        outs = sess.run(None, {"x": x})
        loc = next(o for o in outs if o.ndim == 3 and o.shape[2] == 8)
        probs = next(o for o in outs if o.ndim == 3 and o.shape[2] == len(vocab))
        cells = decode_cells(loc, probs, vocab)
        passed = len(cells) == expect
        ok = ok and passed
        print(f"{'PASS' if passed else 'FAIL'}  {cols}×{rows} 合成表：解出 {len(cells)} 格（期望 {expect}）")

    # Loop 只回報、不判死。實測（bench/experiments/SLANET_FINDINGS.md）：
    # 1.0.8 轉出來的圖含一個 Loop（解碼器的自回歸循環），但 onnxruntime-web 1.31.1
    # 照樣載得進來、310 ms 跑完、解出 15／20 格；真正讓 web 拒絕的是 2.1.0 那個
    # 無效的 Concat.27（連桌機版都載不進去，上面那關就會先失敗）。
    _, note = check_web_safe(args.out)
    print(f"INFO  {note}（Loop 不影響 web，實測見 SLANET_FINDINGS.md）")
    print("\n結論：", "可以接進 App（放進 static/models/ 再開 worker 的結構模式）" if ok
          else "還不能接：格數不對，先照 README/bench 說明的下一步處理")
    # 判準是「載得進來 + 格數正確」；Loop 本身不是問題（舊版把它當失敗條件，
    # 等於把唯一能用的那顆模型判死）
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
