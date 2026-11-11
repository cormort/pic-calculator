import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from pdf_table import extract_table as extract_pdf_table
from table_ocr import extract_table

app = FastAPI(title="圖片計算器")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# Serve PWA files from root with correct MIME types
@app.get("/manifest.json")
async def manifest():
    return FileResponse(
        os.path.join(STATIC_DIR, "manifest.json"),
        media_type="application/manifest+json",
    )

@app.get("/sw.js")
async def sw():
    return FileResponse(
        os.path.join(STATIC_DIR, "sw.js"),
        media_type="application/javascript",
    )


@app.get("/", response_class=HTMLResponse)
async def root():
    index_path = os.path.join(STATIC_DIR, "index.html")
    with open(index_path, encoding="utf-8") as f:
        return f.read()


@app.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    content_type = file.content_type or ""
    raw = await file.read()
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="檔案過大，請上傳 20MB 以下的檔案")

    is_pdf = content_type == "application/pdf" or raw[:5] == b"%PDF-"
    is_image = content_type.startswith("image/")
    if not (is_pdf or is_image):
        raise HTTPException(status_code=400, detail="請上傳 PDF 或圖片檔案")

    try:
        if is_pdf:
            result = await run_in_threadpool(extract_pdf_table, raw)
        else:
            result = await run_in_threadpool(extract_table, raw)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"表格辨識失敗：{e}")

    table_data = result["data"]
    if not table_data:
        raise HTTPException(status_code=422, detail="未能辨識出表格內容")

    return {
        "success": True,
        "method": result["method"],
        "table": table_data,
        "indent": result.get("indent", []),
        "confidence": result.get("confidence", []),
    }


def _find_free_port(start: int, tries: int = 50) -> int:
    """從 start 開始找第一個可綁定的埠（被佔就往後跳）。"""
    import socket

    for p in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("0.0.0.0", p))
                return p
            except OSError:
                continue
    return start


def _lan_ip():
    """取得本機區網 IP（供手機連線）。"""
    import socket

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


if __name__ == "__main__":
    port = _find_free_port(8001)
    ip = _lan_ip()
    print("\n" + "=" * 50)
    print(" 伺服器啟動中...")
    print(f" 本機開啟：  http://localhost:{port}")
    if ip:
        print(f" 手機開啟：  http://{ip}:{port}")
        print("            (手機需與本電腦連同一個 WiFi)")
    print("=" * 50 + "\n")
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)