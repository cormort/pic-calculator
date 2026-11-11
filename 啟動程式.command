#!/bin/bash

cd "$(dirname "$0")"

NEXA_VENV="/Users/hsiehminchieh/Dev/Work/NexaAI-DeepSeek-OCR-GGUF/.venv"

if [ -x "$NEXA_VENV/bin/python" ]; then
  echo "使用 NexaAI venv (內含 PaddleOCR)..."
  PYTHON="$NEXA_VENV/bin/python"
else
  echo "找不到 NexaAI venv，使用本地 venv 並安裝依賴..."
  [ -d "venv" ] || python3 -m venv venv
  source venv/bin/activate
  pip3 install -r requirements.txt
  PYTHON="python3"
fi

export DISABLE_MODEL_SOURCE_CHECK=True
# 埠號與連線網址由 app/main.py 啟動時印出（首選 8001，被佔自動跳下一個）
"$PYTHON" app/main.py
