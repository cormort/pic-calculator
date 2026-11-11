"""table_ocr 的單元測試（不需要載入 OCR 模型）。

執行：
    .venv/bin/python tests/test_table_ocr.py -v
"""

import io
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from PIL import Image, ImageDraw  # noqa: E402

import table_ocr  # noqa: E402


def make_cell(text, x1, x2, cy=100.0, h=20.0, score=1.0):
    return {
        "text": text,
        "x1": x1, "x2": x2,
        "y1": cy - h / 2, "y2": cy + h / 2,
        "cx": (x1 + x2) / 2, "cy": cy,
        "h": h, "w": x2 - x1,
        "score": score,
    }


class ColumnAlignmentTest(unittest.TestCase):
    def test_centered_header_and_right_aligned_numbers_share_columns(self):
        # 表頭置中、數字右對齊：中心點分群會拆成 5 欄，空白帶切欄應為 3 欄
        rows = [
            [make_cell("科目", 44, 107),
             make_cell("本年", 653, 722),
             make_cell("上年", 1013, 1081)],
            [make_cell("營業收入", 53, 161),
             make_cell("1,234,567", 744, 863),
             make_cell("1,111,222", 1104, 1224)],
            [make_cell("營業成本", 53, 161),
             make_cell("(987,654)", 745, 861),
             make_cell("(900,000)", 1106, 1222)],
        ]

        table, confidence = table_ocr._align_columns(rows)

        self.assertEqual(len(table[0]), 3)
        self.assertEqual(table[0], ["科目", "本年", "上年"])
        self.assertEqual(table[1], ["營業收入", "1,234,567", "1,111,222"])
        self.assertEqual(table[2], ["營業成本", "(987,654)", "(900,000)"])
        self.assertEqual(confidence[1], [1.0, 1.0, 1.0])

    def test_empty_cell_keeps_column_position(self):
        rows = [
            [make_cell("項目", 20, 80),
             make_cell("金額", 400, 460),
             make_cell("%", 700, 730)],
            [make_cell("收入", 20, 80),
             make_cell("1,000", 390, 460),
             make_cell("10%", 700, 730)],
            [make_cell("支出", 20, 80),
             make_cell("500", 410, 460),
             make_cell("5%", 700, 730)],
        ]

        table, _ = table_ocr._align_columns(rows)

        self.assertEqual([len(r) for r in table], [3, 3, 3])
        self.assertEqual(table[1][1], "1,000")

    def test_cell_score_is_min_of_words(self):
        cell = table_ocr._pack_cell([
            make_cell("1,234", 10, 60, score=0.95),
            make_cell("567", 62, 100, score=0.40),
        ])
        self.assertAlmostEqual(cell["score"], 0.40)

        table, confidence = table_ocr._align_columns([
            [make_cell("1,234 567", 10, 100, score=0.40),
             make_cell("8,900", 300, 360, score=0.90)],
        ])
        self.assertEqual(len(table[0]), 2)
        self.assertAlmostEqual(confidence[0][0], 0.40)
        self.assertAlmostEqual(confidence[0][1], 0.90)

    def test_empty_input(self):
        self.assertEqual(table_ocr._align_columns([]), ([], []))


class ImagePreprocessTest(unittest.TestCase):
    @staticmethod
    def _jpeg_with_exif(img, orientation):
        exif = Image.Exif()
        exif[274] = orientation
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=95, exif=exif)
        return buf.getvalue()

    def test_exif_orientation_is_applied(self):
        upright = Image.new("RGB", (400, 200), "white")
        draw = ImageDraw.Draw(upright)
        draw.rectangle([0, 0, 399, 199], outline="black", width=6)
        stored = upright.rotate(90, expand=True)  # 模擬手機直拍：像素橫躺

        prepared = table_ocr._prepare_image(
            self._jpeg_with_exif(stored, orientation=6)
        )

        self.assertEqual(prepared.size, (400, 200))

    def test_deskew_angle_is_detected(self):
        img = Image.new("RGB", (800, 300), "white")
        draw = ImageDraw.Draw(img)
        for y in (40, 150, 260):
            draw.line([(20, y), (780, y)], fill="black", width=4)
        rotated = img.rotate(6, expand=True, fillcolor="white")

        angle = table_ocr._detect_skew_angle(rotated)

        self.assertAlmostEqual(angle, -6.0, delta=1.5)

    def test_level_image_is_not_rotated(self):
        img = Image.new("RGB", (800, 300), "white")
        draw = ImageDraw.Draw(img)
        for y in (40, 150, 260):
            draw.line([(20, y), (780, y)], fill="black", width=4)
        self.assertEqual(table_ocr._detect_skew_angle(img), 0.0)


if __name__ == "__main__":
    unittest.main()
