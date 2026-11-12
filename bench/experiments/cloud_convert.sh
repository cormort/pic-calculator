#!/usr/bin/env bash
# 在 Linux 雲端主機上跑：把 PaddleOCR 的 SLANet 轉成 onnxruntime-web 載得進來的 ONNX。
#
# 用法（Ubuntu/Debian，只需要能連外網）：
#   curl -fsSL https://raw.githubusercontent.com/cormort/pic-calculator/main/bench/experiments/cloud_convert.sh | bash
#
# 或先下載再看內容：
#   curl -fsSLO https://raw.githubusercontent.com/cormort/pic-calculator/main/bench/experiments/cloud_convert.sh
#   less cloud_convert.sh && bash cloud_convert.sh
#
# 它會：
#   1. 準備 python3.11 虛擬環境（沒有就提示怎麼裝）
#   2. 依序試幾組 paddle / paddle2onnx 版本，每組都跑「轉檔 + 驗收」
#   3. 第一組通過（3×4→15 格、4×4→20 格、不含 Loop）就停下並印出檔案路徑與 sha256
#
# 驗收沒過就換下一組；全部沒過會列出每組的失敗原因。
set -uo pipefail

REPO_URL="${REPO_URL:-https://github.com/cormort/pic-calculator.git}"
WORKDIR="${WORKDIR:-$HOME/slanet-convert}"
PY="${PY:-python3.11}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

say "檢查環境"
command -v git >/dev/null || die "需要 git：sudo apt-get install -y git"
command -v "$PY" >/dev/null || die "找不到 $PY。Ubuntu：sudo apt-get install -y python3.11 python3.11-venv
（或設 PY=python3.10 / PY=python3.12 再跑一次）"
"$PY" -c 'import venv' 2>/dev/null || die "缺 venv 模組：sudo apt-get install -y python3.11-venv"
echo "python: $($PY -V)  工作目錄: $WORKDIR"

say "取得程式"
mkdir -p "$WORKDIR"
if [ -d "$WORKDIR/pic-calculator/.git" ]; then
  git -C "$WORKDIR/pic-calculator" pull --ff-only || true
else
  git clone --depth 1 "$REPO_URL" "$WORKDIR/pic-calculator" || die "clone 失敗"
fi
SCRIPT="$WORKDIR/pic-calculator/bench/experiments/convert_slanet.py"
[ -f "$SCRIPT" ] || die "找不到 $SCRIPT"

mkdir -p "$WORKDIR/out"
PASSED=""

# 依序試：新到舊。paddle2onnx 1.0.x 是社群回報能轉出乾淨 SLANet 的版本。
COMBOS=(
  "2.6.2 1.0.6"
  "2.6.2 1.0.9"
  "3.3.1 2.1.0"
)
for combo in "${COMBOS[@]}"; do
  set -- $combo
  PADDLE_VER="$1"; P2O_VER="$2"
  VENV="$WORKDIR/venv-$PADDLE_VER-$P2O_VER"
  OUT="$WORKDIR/out/slanet_plus_paddle${PADDLE_VER}_p2o${P2O_VER}.onnx"

  say "試 paddlepaddle==$PADDLE_VER + paddle2onnx==$P2O_VER"
  rm -rf "$VENV"
  "$PY" -m venv "$VENV" || { echo "建立 venv 失敗，跳過"; continue; }
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
  pip install -q --upgrade pip

  if ! pip install -q "paddlepaddle==$PADDLE_VER" "paddle2onnx==$P2O_VER" \
        onnx onnxruntime pillow numpy; then
    echo "安裝失敗（這組版本在你的機器上沒有 wheel），跳過"
    deactivate; continue
  fi

  if python "$SCRIPT" --out "$OUT" --workdir "$WORKDIR/model"; then
    PASSED="$OUT"
    deactivate
    break
  fi
  echo "這組沒通過驗收，換下一組"
  deactivate
done

if [ -z "$PASSED" ]; then
  say "全部組合都沒通過"
  echo "把上面每一組的錯誤訊息貼回對話即可；下一步會是 ONNX 圖手術（展開 Loop）或改走伺服器端。"
  exit 1
fi

say "通過！"
ls -l "$PASSED"
echo "sha256: $(sha256sum "$PASSED" | cut -d' ' -f1)"
cat <<EOF

把檔案帶回 Mac（在 Mac 上執行，把 user@host 換成你的主機）：
  scp user@host:$PASSED ~/Downloads/slanet_plus.onnx

或者放到任何能給出直接連結的地方（不要放 Yahoo/Google 短網址），把 URL 貼回對話。

拿到之後我會：
  1. 放進 pic-calculator/static/models/slanet_plus.onnx
  2. 接回 worker 的結構模式（程式已寫過一版，在 git 記錄裡）
  3. 用 bench/probe/g-borderless.png 驗收：目前 23.1% 格正確 / 數字格 0%，目標 80%+
EOF
