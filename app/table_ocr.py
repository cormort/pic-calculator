"""表格 OCR：使用 PaddleOCR 取得文字 + 座標，重建二維表格。"""

import io
import os
import re
import threading
from typing import Any, Dict, List, Tuple

import numpy as np
from PIL import Image, ImageOps

os.environ.setdefault("DISABLE_MODEL_SOURCE_CHECK", "True")

_OCR_INSTANCE = None
_OCR_LOCK = threading.Lock()

# 自動轉正：只修小幅傾斜，超過這個角度視為偵測錯誤，寧可不轉。
_MAX_SKEW_DEG = 15.0
_MIN_SKEW_DEG = 0.3

# 判斷資料列用：整格都是數字/千分位/括號負數/百分比符號。
_NUMERIC_CELL_RE = re.compile(r"^[-\d.,，()$%％\s]+$")


def _get_ocr():
    global _OCR_INSTANCE
    if _OCR_INSTANCE is None:
        with _OCR_LOCK:
            if _OCR_INSTANCE is None:
                from paddleocr import PaddleOCR

                _OCR_INSTANCE = PaddleOCR(
                    lang="chinese_cht",
                    ocr_version="PP-OCRv5",
                    use_doc_orientation_classify=False,
                    use_doc_unwarping=False,
                    use_textline_orientation=False,
                )
    return _OCR_INSTANCE


def _detect_skew_angle(img: Image.Image) -> float:
    """用長直線（表格框線）估計整頁傾斜角；沒有足夠框線時回傳 0。"""
    try:
        import cv2
    except ImportError:
        return 0.0

    gray = np.asarray(img.convert("L"))
    if gray.size == 0:
        return 0.0
    try:
        binary = cv2.threshold(
            gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
        )[1]
    except cv2.error:
        return 0.0

    width = binary.shape[1]
    min_len = max(int(width * 0.3), 60)
    lines = cv2.HoughLinesP(
        binary,
        1,
        np.pi / 180,
        threshold=100,
        minLineLength=min_len,
        maxLineGap=max(int(width * 0.01), 10),
    )
    if lines is None:
        return 0.0

    angles: List[float] = []
    for x1, y1, x2, y2 in lines[:, 0]:
        dx, dy = float(x2) - float(x1), float(y2) - float(y1)
        angle = float(np.degrees(np.arctan2(dy, dx)))
        if -_MAX_SKEW_DEG <= angle <= _MAX_SKEW_DEG:
            angles.append(angle)
    if len(angles) < 3:
        return 0.0

    angle = float(np.median(angles))
    return 0.0 if abs(angle) < _MIN_SKEW_DEG else angle


def _prepare_image(image_bytes: bytes) -> Image.Image:
    """套用 EXIF 方向並轉正；回傳 RGB 影像。"""
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(image_bytes)))
    if img.mode != "RGB":
        img = img.convert("RGB")

    angle = _detect_skew_angle(img)
    if angle:
        img = img.rotate(
            angle, expand=True, fillcolor=(255, 255, 255), resample=Image.BICUBIC
        )
    return img


def _bbox_from_polygon(poly) -> Tuple[float, float, float, float, float, float]:
    arr = np.asarray(poly, dtype=float).reshape(-1, 2)
    x1, y1 = arr[:, 0].min(), arr[:, 1].min()
    x2, y2 = arr[:, 0].max(), arr[:, 1].max()
    return x1, y1, x2, y2, (x1 + x2) / 2, (y1 + y2) / 2


def _ocr_words(image_bytes: bytes) -> List[Dict[str, Any]]:
    img = _prepare_image(image_bytes)
    arr = np.array(img)

    ocr = _get_ocr()
    with _OCR_LOCK:  # PaddleOCR predictor 非執行緒安全；序列化請求避免互相踩踏
        raw = ocr.predict(input=arr)

    words: List[Dict[str, Any]] = []
    for res in raw:
        polys = res.get("rec_polys") if isinstance(res, dict) else getattr(res, "rec_polys", None)
        texts = res.get("rec_texts") if isinstance(res, dict) else getattr(res, "rec_texts", None)
        scores = res.get("rec_scores") if isinstance(res, dict) else getattr(res, "rec_scores", None)
        if polys is None or texts is None:
            continue
        for i, (poly, text) in enumerate(zip(polys, texts)):
            text = (text or "").strip()
            if not text:
                continue
            x1, y1, x2, y2, cx, cy = _bbox_from_polygon(poly)
            words.append({
                "text": text,
                "x1": float(x1), "y1": float(y1),
                "x2": float(x2), "y2": float(y2),
                "cx": float(cx), "cy": float(cy),
                "h": float(y2 - y1), "w": float(x2 - x1),
                "score": float(scores[i]) if scores is not None and i < len(scores) else 1.0,
            })
    return words


def _cluster_rows(words: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    """依 y 軸分群成列：相鄰中心點距離小於 0.6 倍平均行高。"""
    if not words:
        return []
    avg_h = sum(w["h"] for w in words) / len(words)
    y_tol = max(avg_h * 0.55, 6.0)

    sorted_w = sorted(words, key=lambda w: w["cy"])
    rows: List[List[Dict[str, Any]]] = []
    current: List[Dict[str, Any]] = []
    last_cy = None
    for w in sorted_w:
        if not current or (last_cy is not None and abs(w["cy"] - last_cy) <= y_tol):
            current.append(w)
            last_cy = sum(c["cy"] for c in current) / len(current)
        else:
            rows.append(current)
            current = [w]
            last_cy = w["cy"]
    if current:
        rows.append(current)
    return rows


def _merge_within_row(row: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """同列內，相鄰 word 若間距小於平均字高 0.7 倍視為同 cell。"""
    if not row:
        return []
    avg_h = sum(w["h"] for w in row) / len(row)
    gap_tol = max(avg_h * 0.7, 8.0)

    sorted_r = sorted(row, key=lambda w: w["x1"])
    cells: List[Dict[str, Any]] = []
    cur_words = [sorted_r[0]]
    cur_x2 = sorted_r[0]["x2"]
    for w in sorted_r[1:]:
        gap = w["x1"] - cur_x2
        if gap <= gap_tol:
            cur_words.append(w)
            cur_x2 = max(cur_x2, w["x2"])
        else:
            cells.append(_pack_cell(cur_words))
            cur_words = [w]
            cur_x2 = w["x2"]
    cells.append(_pack_cell(cur_words))
    return cells


def _pack_cell(words: List[Dict[str, Any]]) -> Dict[str, Any]:
    text = " ".join(w["text"] for w in words).strip()
    x1 = min(w["x1"] for w in words)
    x2 = max(w["x2"] for w in words)
    y1 = min(w["y1"] for w in words)
    y2 = max(w["y2"] for w in words)
    return {
        "text": text,
        "x1": x1, "x2": x2, "y1": y1, "y2": y2,
        "cx": (x1 + x2) / 2, "cy": (y1 + y2) / 2,
        "score": min(float(w["score"]) for w in words),
    }


def _column_bounds(rows_of_cells: List[List[Dict[str, Any]]]) -> List[float]:
    """用「資料列之間沒有文字覆蓋的垂直空白帶」切欄。

    只看含數字的資料列：表頭常置中、數字常右對齊，兩者中心點不同，但
    都不會跨越真正的欄界。以空白帶切欄可避免表頭與數字被拆到不同欄；
    標題、區塊名稱等單一 cell 的列不參與估計。
    """
    if not rows_of_cells:
        return []

    numeric_rows = [
        r for r in rows_of_cells
        if any(_NUMERIC_CELL_RE.match(c["text"] or "") for c in r)
    ]
    sample = numeric_rows or [r for r in rows_of_cells if len(r) >= 2] or rows_of_cells
    intervals = sorted(
        (float(c["x1"]), float(c["x2"])) for row in sample for c in row
    )
    merged: List[List[float]] = []
    for x1, x2 in intervals:
        if merged and x1 <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], x2)
        else:
            merged.append([x1, x2])

    heights = [float(c["y2"] - c["y1"]) for row in rows_of_cells for c in row]
    med_h = float(np.median(heights)) if heights else 20.0
    min_gap = max(med_h * 0.8, 12.0)

    bounds: List[float] = [merged[0][0]]
    for (_, prev_x2), (next_x1, _) in zip(merged, merged[1:]):
        if next_x1 - prev_x2 >= min_gap:
            bounds.append((prev_x2 + next_x1) / 2)
    bounds.append(merged[-1][1])
    return bounds


def _column_of(cell: Dict[str, Any], bounds: List[float]) -> int:
    """取與 cell 水平重疊最多的欄；完全落在框外時取中心點最近的欄。"""
    best_i, best_overlap = 0, -1.0
    for i in range(len(bounds) - 1):
        overlap = min(cell["x2"], bounds[i + 1]) - max(cell["x1"], bounds[i])
        if overlap > best_overlap:
            best_i, best_overlap = i, overlap
    if best_overlap <= 0:
        cx = float(cell["cx"])
        best_i = min(
            range(len(bounds) - 1),
            key=lambda i: abs((bounds[i] + bounds[i + 1]) / 2 - cx),
        )
    return best_i


def _align_columns(
    rows_of_cells: List[List[Dict[str, Any]]],
) -> Tuple[List[List[str]], List[List[float]]]:
    """依全域欄界把每列 cell 放進對應欄，並保留每格最低 OCR 信心。"""
    if not rows_of_cells:
        return [], []

    bounds = _column_bounds(rows_of_cells)
    ncols = max(len(bounds) - 1, 1)
    table: List[List[str]] = []
    confidence: List[List[float]] = []
    for row in rows_of_cells:
        out = [""] * ncols
        scores = [1.0] * ncols
        for c in row:
            ci = _column_of(c, bounds)
            out[ci] = (out[ci] + " " + c["text"]).strip() if out[ci] else c["text"]
            scores[ci] = min(scores[ci], float(c.get("score", 1.0)))
        table.append(out)
        confidence.append([round(s, 4) for s in scores])

    while ncols > 1 and all(not r[-1].strip() for r in table):
        for row in table:
            row.pop()
        for row in confidence:
            row.pop()
        ncols -= 1

    return table, confidence


def extract_table(image_bytes: bytes) -> Dict[str, Any]:
    """執行 OCR 並重建表格。"""
    words = _ocr_words(image_bytes)
    if not words:
        return {"method": "paddleocr", "data": [], "confidence": [], "words": []}

    rows = _cluster_rows(words)
    rows_of_cells = [_merge_within_row(r) for r in rows]
    rows_of_cells = [r for r in rows_of_cells if r]

    table, confidence = _align_columns(rows_of_cells)
    kept = [(r, c) for r, c in zip(table, confidence) if any(x.strip() for x in r)]
    table = [r for r, _ in kept]
    confidence = [c for _, c in kept]

    return {
        "method": "paddleocr",
        "data": table,
        "confidence": confidence,
        "word_count": len(words),
    }
