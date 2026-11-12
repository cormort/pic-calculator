#!/usr/bin/env python3
"""產生「可搜尋的掃描 PDF」：整頁一張圖 + 不可見（3 Tr）的 OCR 文字層。

App 應該判定這種文字層不可信、改走 OCR（摘要出現「隱藏 OCR 文字」與「改用文字層」按鈕）。
隱藏層的數字故意寫錯（全部 999），直接採用就會露餡。

用法：python3 bench/make_hidden_text_pdf.py   → bench/probe/shots/scan-hidden-text.pdf
"""
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "shots", "c-lowres.jpg"), "rb") as f:
    jpeg = f.read()


def jpeg_size(data):
    """從 SOF 標記讀寬高（不依賴 PIL）。"""
    i = 2
    while i < len(data):
        marker, length = data[i + 1], struct.unpack(">H", data[i + 2:i + 4])[0]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return w, h
        i += 2 + length
    raise ValueError("not a JPEG")


IW, IH = jpeg_size(jpeg)
W, H = 595, round(595 * IH / IW)
text = "".join(f"1 0 0 1 {60 + 130 * c} {H - 40 - 22 * r} Tm (item{r} 999) Tj\n"
               for r in range(12) for c in range(4))
content = f"q {W} 0 0 {H} 0 0 cm /Im0 Do Q\nBT 3 Tr /F1 10 Tf\n{text}ET\n".encode()

objs = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W} {H}] /Contents 4 0 R "
    f"/Resources << /XObject << /Im0 5 0 R >> /Font << /F1 6 0 R >> >> >>".encode(),
    b"<< /Length %d >>\nstream\n" % len(content) + content + b"endstream",
    f"<< /Type /XObject /Subtype /Image /Width {IW} /Height {IH} /ColorSpace /DeviceRGB "
    f"/BitsPerComponent 8 /Filter /DCTDecode /Length {len(jpeg)} >>\nstream\n".encode() + jpeg + b"\nendstream",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]
out = bytearray(b"%PDF-1.4\n")
offsets = []
for i, body in enumerate(objs, 1):
    offsets.append(len(out))
    out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
xref = len(out)
out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)

dest = os.path.join(HERE, "probe", "shots", "scan-hidden-text.pdf")
with open(dest, "wb") as f:
    f.write(out)
print(f"wrote {dest} ({len(out)} bytes)")
