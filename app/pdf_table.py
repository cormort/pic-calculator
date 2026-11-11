"""PDF 表格抽取：直接讀取 PDF 內嵌文字 + 座標重建表格（僅第 1 頁）。

相較於對圖片做 OCR，數位 PDF 可取得精準的文字與位置，
能重建近乎完美的格子，並保留科目欄的縮排層級供階層驗算使用。
"""

import io
from statistics import median
from typing import Any, Dict, List


def _column_bounds(page) -> List[float]:
    """由表格的垂直框線取得欄位邊界；找不到時回傳空陣列。"""
    tables = page.find_tables({
        "vertical_strategy": "lines",
        "horizontal_strategy": "text",
    })
    if not tables:
        return []
    xs = set()
    for c in tables[0].cells:
        if c:
            xs.add(round(c[0], 1))
            xs.add(round(c[2], 1))
    bounds: List[float] = []
    for x in sorted(xs):
        if not bounds or x - bounds[-1] > 5:
            bounds.append(x)
    if not bounds:
        return []
    # 最左欄通常是「科目」名稱欄，位於第一條框線左側 → 補上頁面左緣
    left = float(page.bbox[0])
    if bounds[0] - left > 10:
        bounds = [left] + bounds
    return bounds


def _cluster_rows(words: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    """依文字的 top 座標分群成列。"""
    if not words:
        return []
    heights = [w["bottom"] - w["top"] for w in words]
    tol = max(3.0, median(heights) * 0.6)
    words = sorted(words, key=lambda w: w["top"])
    rows: List[List[Dict[str, Any]]] = []
    cur: List[Dict[str, Any]] = []
    last = None
    for w in words:
        if last is None or abs(w["top"] - last) <= tol:
            cur.append(w)
        else:
            rows.append(cur)
            cur = [w]
        last = w["top"]
    if cur:
        rows.append(cur)
    return rows


def extract_table(pdf_bytes: bytes) -> Dict[str, Any]:
    """重建第 1 頁的表格。回傳 data（二維字串）與 indent（每列科目欄起始 x，供階層判斷）。"""
    import pdfplumber

    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        if not pdf.pages:
            return {"method": "pdf", "data": [], "indent": [], "word_count": 0}
        page = pdf.pages[0]
        bounds = _column_bounds(page)
        words = page.extract_words(x_tolerance=1.5, y_tolerance=2)

    if not words:
        return {"method": "pdf", "data": [], "indent": [], "word_count": 0}

    # 無框線時：用文字 x 中心點推估欄位邊界
    if len(bounds) < 2:
        centers = sorted((w["x0"] + w["x1"]) / 2 for w in words)
        gap = max(8.0, median(w["x1"] - w["x0"] for w in words))
        bounds = [centers[0] - gap]
        for cx in centers[1:]:
            if cx - bounds[-1] > gap * 2:
                bounds.append(cx)
        bounds.append(centers[-1] + gap)

    def col_of(x: float) -> int:
        for i in range(len(bounds) - 1):
            if bounds[i] - 3 <= x < bounds[i + 1] + 3:
                return i
        return len(bounds) - 2

    ncol = len(bounds) - 1
    data: List[List[str]] = []
    indent: List[float] = []
    for row in _cluster_rows(words):
        cells = [""] * ncol
        name_x = None
        for w in sorted(row, key=lambda w: w["x0"]):
            ci = col_of((w["x0"] + w["x1"]) / 2)
            cells[ci] = (cells[ci] + " " + w["text"]).strip() if cells[ci] else w["text"]
            if ci == 0 and name_x is None:
                name_x = w["x0"]
        if any(c.strip() and c.strip() not in "-－" for c in cells):
            data.append(cells)
            indent.append(round(name_x, 1) if name_x is not None else 0.0)

    return {
        "method": "pdf",
        "data": data,
        "indent": indent,
        "word_count": len(words),
    }
