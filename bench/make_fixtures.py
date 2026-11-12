#!/usr/bin/env python3
"""產生中文表格測試圖（含「實拍」劣化：透視、斜轉、模糊、低解析度、JPEG）。

用法：.venv/bin/python make_fixtures.py
輸出：shots/*.jpg|png 與 truth/*.json
"""
import json
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "shots")
TRUTH = os.path.join(HERE, "truth")

FONT_CANDIDATES = [
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
]


def load_font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    raise SystemExit("找不到中文字型")


# ---------------------------------------------------------------- 表格資料
# A：經費執行明細表（4 個數字欄、含小計/合計列）
TABLE_A = {
    "title": "113年度補助計畫經費執行明細表",
    "header": ["項次", "會計科目", "單價", "數量", "金額"],
    "rows": [
        ["1", "人事費", "", "", ""],
        ["1-1", "主持人費", "25,000", "8", "200,000"],
        ["1-2", "兼任助理", "12,000", "15", "180,000"],
        ["1-3", "臨時工資", "1,400", "120", "168,000"],
        ["小計", "", "", "", "548,000"],
        ["2", "業務費", "", "", ""],
        ["2-1", "文具用品", "12,345", "3", "37,035"],
        ["2-2", "印刷費", "45,600", "2", "91,200"],
        ["2-3", "國內旅費", "18,750", "4", "75,000"],
        ["2-4", "雜支", "158,496", "1", "158,496"],
        ["小計", "", "", "", "361,731"],
        ["合計", "", "", "", "909,731"],
    ],
}

# B：資產負債表（分組列合併儲存格、合計層層往上）
TABLE_B = {
    "title": "某大學資產負債表",
    "header": ["科目", "112年度", "111年度"],
    "rows": [
        ["流動資產", "", ""],
        ["現金及約當現金", "1,920,497", "1,899,302"],
        ["其他流動資產", "969,524", "1,071,262"],
        ["流動資產合計", "2,890,021", "2,970,564"],
        ["非流動資產", "", ""],
        ["不動產、廠房及設備", "6,355,416", "6,084,377"],
        ["其他非流動資產", "646,219", "494,815"],
        ["非流動資產合計", "7,001,635", "6,579,192"],
        ["資產總計", "9,891,656", "9,549,756"],
        ["流動負債", "", ""],
        ["短期借款", "300,000", "50,000"],
        ["其他流動負債", "2,579,037", "2,423,150"],
        ["流動負債合計", "2,879,037", "2,473,150"],
        ["負債總計", "3,563,684", "3,766,807"],
        ["權益", "", ""],
        ["資本", "6,000,000", "5,500,000"],
        ["保留盈餘", "327,972", "282,949"],
        ["權益合計", "6,327,972", "5,782,949"],
        ["負債及權益總計", "9,891,656", "9,549,756"],
    ],
}


def render(table, width=1600, title_scale=1.0):
    """把表格畫成乾淨的白底圖（模擬掃描件/螢幕截圖）。"""
    cols = len(table["header"])
    # 欄寬權重：中文科目欄寬、數字欄窄
    weights = []
    for i, h in enumerate(table["header"]):
        if i == 1 or (cols == 3 and i == 0):
            weights.append(3.2)
        else:
            weights.append(1.6)
    total_w = sum(weights)
    margin = int(width * 0.04)
    avail = width - margin * 2
    col_w = [avail * w / total_w for w in weights]

    fs_title = int(width * 0.026 * title_scale)
    fs_body = int(width * 0.019 * title_scale)
    f_title = load_font(fs_title)
    f_body = load_font(fs_body)
    f_head = load_font(int(fs_body * 1.02))

    pad_y = int(fs_body * 0.75)
    row_h = fs_body + pad_y * 2
    head_h = int(row_h * 1.15)
    title_h = int(fs_title * 2.6)
    height = title_h + head_h + row_h * len(table["rows"]) + margin

    img = Image.new("RGB", (width, height), "white")
    d = ImageDraw.Draw(img)

    # 標題置中
    tw = d.textlength(table["title"], font=f_title)
    d.text(((width - tw) / 2, int(fs_title * 0.8)), table["title"], font=f_title, fill=(20, 20, 20))

    x0, y0 = margin, title_h
    grid = (60, 60, 60)

    def cell_box(r, c):
        x = x0 + sum(col_w[:c])
        y = y0 + (0 if r == -1 else head_h + row_h * r)
        h = head_h if r == -1 else row_h
        return x, y, col_w[c], h

    # 表頭底色
    d.rectangle([x0, y0, x0 + sum(col_w), y0 + head_h], fill=(232, 236, 246))

    for c, text in enumerate(table["header"]):
        x, y, w, h = cell_box(-1, c)
        tw = d.textlength(text, font=f_head)
        d.text((x + (w - tw) / 2, y + (h - fs_body) / 2 - int(fs_body * 0.08)), text,
               font=f_head, fill=(10, 10, 10))

    numeric_cols = set()
    for c in range(cols):
        vals = [r[c] for r in table["rows"] if c < len(r)]
        if any(v.replace(",", "").replace("-", "").isdigit() for v in vals if v):
            numeric_cols.add(c)

    for r, row in enumerate(table["rows"]):
        for c, text in enumerate(row):
            x, y, w, h = cell_box(r, c)
            if not text:
                continue
            right = c in numeric_cols
            if c == 1 or (cols == 3 and c == 0):
                right = False
            tw = d.textlength(text, font=f_body)
            tx = x + w - tw - int(fs_body * 0.35) if right else x + int(fs_body * 0.3)
            d.text((tx, y + pad_y), text, font=f_body, fill=(25, 25, 25))

    # 格線（外框較粗）
    for r in range(-1, len(table["rows"])):
        x, y, w, h = cell_box(r, 0)
        d.line([x0, y, x0 + sum(col_w), y], fill=grid, width=2)
    d.line([x0, y0 + head_h + row_h * len(table["rows"])] * 2, fill=grid, width=2)
    x = x0
    for c in range(cols + 1):
        d.line([x, y0, x, y0 + head_h + row_h * len(table["rows"])], fill=grid, width=2)
        if c < cols:
            x += col_w[c]
    d.rectangle([x0, y0, x0 + sum(col_w), y0 + head_h + row_h * len(table["rows"])], outline=(30, 30, 30), width=3)
    return img


def homography(src_w, src_h, dst_quad):
    """回傳 3x3 H，把 (0,0),(w,0),(w,h),(0,h) 映射到 dst_quad。"""
    src = [(0, 0), (src_w, 0), (src_w, src_h), (0, src_h)]
    A, b = [], []
    for (x, y), (u, v) in zip(src, dst_quad):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        b.extend([u, v])
    h = np.linalg.solve(np.array(A, float), np.array(b, float))
    return np.append(h, 1).reshape(3, 3)


def warp(sheet, canvas_size, quad, shadow=True):
    """把表格貼進拍照畫布：透視 + 紙張陰影 + 背景。"""
    W, H = canvas_size
    arr = np.asarray(sheet.convert("RGB"), dtype=np.float32)
    sh, sw = arr.shape[:2]
    Hm = homography(sw, sh, quad)

    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    pts = np.stack([xs.ravel(), ys.ravel(), np.ones(W * H, np.float32)])
    src = np.linalg.inv(Hm) @ pts
    sx = (src[0] / src[2]).reshape(H, W)
    sy = (src[1] / src[2]).reshape(H, W)
    inside = (sx >= 0) & (sx < sw - 1) & (sy >= 0) & (sy < sh - 1)

    sx0 = np.clip(sx, 0, sw - 1.001)
    sy0 = np.clip(sy, 0, sh - 1.001)
    x0 = sx0.astype(np.int32)
    y0 = sy0.astype(np.int32)
    fx = (sx0 - x0)[..., None]
    fy = (sy0 - y0)[..., None]
    p00 = arr[y0, x0]
    p10 = arr[y0, np.clip(x0 + 1, 0, sw - 1)]
    p01 = arr[np.clip(y0 + 1, 0, sh - 1), x0]
    p11 = arr[np.clip(y0 + 1, 0, sh - 1), np.clip(x0 + 1, 0, sw - 1)]
    sampled = (p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy)
               + p01 * (1 - fx) * fy + p11 * fx * fy)

    # 背景：灰色桌面 + 漸層
    bg = np.zeros((H, W, 3), np.float32)
    bg[..., 0] = 120 + 30 * (xs / W)
    bg[..., 1] = 118 + 25 * (ys / H)
    bg[..., 2] = 112 + 20 * (ys / H)
    bg += np.random.normal(0, 3, (H, W, 3)).astype(np.float32)

    out = np.where(inside[..., None], sampled, bg)
    if shadow:
        # 左下角柔和的陰影
        shade = 1.0 - 0.22 * np.clip((xs / W) * 0.6 + (ys / H) * 0.7 - 0.5, 0, 1)
        out = out * shade[..., None]
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def degrade(img, blur=0.0, noise=0.0, jpeg=None, quality=88):
    from PIL import ImageFilter
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    if noise:
        a = np.asarray(img, np.float32)
        a += np.random.normal(0, noise, a.shape)
        img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    return img


def save(img, path, quality=88):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if path.endswith(".png"):
        img.save(path)
    else:
        img.convert("RGB").save(path, quality=quality, subsampling=1)


def write_truth(table, path):
    data = [table["header"]] + table["rows"]
    with open(path, "w") as f:
        json.dump({"title": table["title"], "rows": data}, f, ensure_ascii=False, indent=1)


def main():
    rng = np.random.default_rng(7)
    os.makedirs(SHOTS, exist_ok=True)
    os.makedirs(TRUTH, exist_ok=True)

    # 1) 乾淨截圖（A4 比例、1600px 寬）
    a = render(TABLE_A, width=1600)
    save(a, os.path.join(SHOTS, "a-clean.png"))
    write_truth(TABLE_A, os.path.join(TRUTH, "a-clean.json"))

    # 2) A 的「手機實拍」：4032x3024 橫拍，表格佔畫面約 70%，輕微透視 + 模糊
    W, H = 3024, 4032
    quad = [(int(rng.uniform(0.10, 0.14) * W), int(rng.uniform(0.10, 0.13) * H)),
            (int(rng.uniform(0.86, 0.90) * W), int(rng.uniform(0.08, 0.11) * H)),
            (int(rng.uniform(0.86, 0.90) * W), int(rng.uniform(0.62, 0.68) * H)),
            (int(rng.uniform(0.10, 0.14) * W), int(rng.uniform(0.64, 0.70) * H))]
    photo = warp(a, (W, H), quad)
    photo = degrade(photo, blur=1.1, noise=2.5)
    save(photo, os.path.join(SHOTS, "b-photo.jpg"), quality=86)
    write_truth(TABLE_A, os.path.join(TRUTH, "b-photo.json"))

    # 3) A 的低解析度／模糊：950px 寬（模擬從 LINE 轉傳壓縮過的圖）
    small = render(TABLE_A, width=950)
    small = degrade(small, blur=0.9, noise=2.0)
    save(small, os.path.join(SHOTS, "c-lowres.jpg"), quality=52)
    write_truth(TABLE_A, os.path.join(TRUTH, "c-lowres.json"))

    # 4) B 資產負債表：乾淨 + 實拍
    b = render(TABLE_B, width=1500)
    save(b, os.path.join(SHOTS, "d-balance.png"))
    write_truth(TABLE_B, os.path.join(TRUTH, "d-balance.json"))

    W2, H2 = 3024, 4032
    quad2 = [(int(0.09 * W2), int(0.07 * H2)), (int(0.90 * W2), int(0.09 * H2)),
             (int(0.91 * W2), int(0.86 * H2)), (int(0.08 * W2), int(0.88 * H2))]
    photo2 = warp(b, (W2, H2), quad2)
    photo2 = degrade(photo2, blur=1.0, noise=2.5)
    save(photo2, os.path.join(SHOTS, "e-balance-photo.jpg"), quality=86)
    write_truth(TABLE_B, os.path.join(TRUTH, "e-balance-photo.json"))

    # 5) A 歪斜 2.4°（手機沒拿正）
    tilted = a.rotate(2.4, resample=Image.BICUBIC, expand=True, fillcolor="white")
    tilted = degrade(tilted, blur=0.5)
    save(tilted, os.path.join(SHOTS, "f-tilted.jpg"), quality=90)
    write_truth(TABLE_A, os.path.join(TRUTH, "f-tilted.json"))

    for name in sorted(os.listdir(SHOTS)):
        p = os.path.join(SHOTS, name)
        im = Image.open(p)
        print(f"{name:24s} {im.size[0]}x{im.size[1]}  {os.path.getsize(p)//1024} KB")


if __name__ == "__main__":
    main()
