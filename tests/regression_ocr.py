"""端到端 OCR 回歸測試（需要 PaddleOCR 模型，約 10–20 秒）。

執行：
    .venv/bin/python tests/regression_ocr.py

測資：
  1. 清晰正拍表格         → 驗證欄位重建
  2. 傾斜 5°              → 驗證自動轉正
  3. EXIF 旋轉 90°（JPEG）→ 驗證手機直拍方向
  4. tests/fixtures/real/balance-sheet-scan.png（若存在）→ 真實掃描驗證
"""

import io
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

import table_ocr  # noqa: E402

FONT_PATH = "/System/Library/Fonts/Supplemental/Arial.ttf"
REAL_FIXTURE = ROOT / "tests" / "fixtures" / "real" / "balance-sheet-scan.png"

EXPECTED = [
    ["Item", "Current", "Prior"],
    ["Revenue", "1,234,567", "1,111,222"],
    ["Cost", "(987,654)", "(900,000)"],
    ["Gross profit", "246,913", "211,222"],
    ["Expenses", "123,456", "100,000"],
    ["Operating profit", "123,457", "111,222"],
]


def _font(size):
    if os.path.exists(FONT_PATH):
        return ImageFont.truetype(FONT_PATH, size)
    return ImageFont.load_default()


def _build_table() -> Image.Image:
    width, height = 1400, 640
    img = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(img)
    f_head, f_body = _font(28), _font(26)

    cols = [40, 520, 880, 1240]
    y0, row_h = 150, 80
    draw.text((44, 100), "Item", font=f_head, fill="black")
    for i, text in enumerate(["Current", "Prior"]):
        tw = draw.textlength(text, font=f_head)
        draw.text(((cols[i + 1] + cols[i + 2]) / 2 - tw / 2, 100), text, font=f_head, fill="black")

    for r in range(len(EXPECTED) + 1):
        y = y0 + r * row_h
        draw.line([(cols[0], y), (cols[-1], y)], fill="black", width=2)
    for x in cols:
        draw.line([(x, y0), (x, y0 + row_h * (len(EXPECTED) + 1))], fill="black", width=2)

    for r, (name, current, prior) in enumerate(EXPECTED[1:], start=1):
        y = y0 + (r - 1) * row_h + 18
        draw.text((cols[0] + 14, y), name, font=f_body, fill="black")
        for ci, value in enumerate((current, prior)):
            tw = draw.textlength(value, font=f_body)
            draw.text((cols[ci + 2] - 18 - tw, y), value, font=f_body, fill="black")
    return img


def _jpeg_with_exif(img: Image.Image, orientation: int) -> bytes:
    exif = Image.Exif()
    exif[274] = orientation
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95, exif=exif)
    return buf.getvalue()


def _normalize(text: str) -> str:
    return " ".join((text or "").split()).lower()


def _check_table(name: str, table, confidence, expected) -> None:
    header_row = None
    for i, row in enumerate(table):
        if row and _normalize(row[0]) == "item":
            header_row = i
            break
    assert header_row is not None, f"{name}: 找不到表頭列，結果={table}"

    header = [_normalize(c) for c in table[header_row]]
    assert header[:3] == ["item", "current", "prior"], f"{name}: 表頭={header}"
    assert all(len(row) == 3 for row in table), f"{name}: 欄數不一致={table}"

    actual = table[header_row:header_row + len(expected)]
    assert len(actual) == len(expected), f"{name}: 列數不足={len(actual)}"
    for i, exp in enumerate(expected):
        got = [_normalize(c) for c in actual[i]]
        want = [_normalize(c) for c in exp]
        assert got == want, f"{name}: 第 {i} 列 {got} != {want}"

    assert len(confidence) == len(table), f"{name}: confidence 列數不符"
    assert all(len(c) == len(r) for c, r in zip(confidence, table)), f"{name}: confidence 欄數不符"


def _run(name: str, raw: bytes) -> None:
    result = table_ocr.extract_table(raw)
    _check_table(name, result["data"], result["confidence"], EXPECTED)
    print(f"PASS  {name}  ({result['word_count']} words, {len(result['data'])} rows)")


def _run_real_fixture() -> None:
    if not REAL_FIXTURE.exists():
        print("SKIP  real balance sheet（tests/fixtures/real/ 內無測資）")
        return

    result = table_ocr.extract_table(REAL_FIXTURE.read_bytes())
    table = result["data"]
    flat = {_normalize(c) for row in table for c in row}
    for value in ("1,920,497", "2,890,021", "9,891,656", "9,549,756"):
        assert value in flat, f"真實掃描：找不到 {value}，結果={table}"
    assert any("106年度" in row for row in table), f"真實掃描：找不到 106年度 表頭"
    assert all(len(row) == 3 for row in table), f"真實掃描：欄數不是 3，結果={table}"
    print(f"PASS  real balance sheet  ({result['word_count']} words, {len(table)} rows)")


def main() -> int:
    try:
        import paddleocr  # noqa: F401
    except ImportError:
        print("SKIP  需要 paddleocr（請用裝有 PaddleOCR 的 venv 執行）")
        return 0

    base = _build_table()
    upright = io.BytesIO()
    base.save(upright, format="PNG")
    _run("upright", upright.getvalue())

    skew = io.BytesIO()
    base.rotate(5, expand=True, fillcolor="white", resample=Image.BICUBIC).save(skew, format="PNG")
    _run("skew 5°", skew.getvalue())

    _run("exif orientation 6", _jpeg_with_exif(base.rotate(90, expand=True), 6))

    _run_real_fixture()
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
