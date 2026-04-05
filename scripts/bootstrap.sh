#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

need_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[bootstrap] missing required command: $cmd" >&2
    exit 1
  fi
}

have_any_cxx() {
  command -v c++ >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1 || command -v clang++ >/dev/null 2>&1
}

need_cmd node
need_cmd npm
need_cmd cmake

if ! have_any_cxx; then
  echo "[bootstrap] missing C++ compiler (need one of: c++, g++, clang++)" >&2
  exit 1
fi

echo "[bootstrap] repo root: $ROOT_DIR"

echo "[bootstrap] installing client/web dependencies"
(
  cd "$ROOT_DIR/client/web"
  npm ci
)

echo "[bootstrap] installing server/gateway dependencies"
(
  cd "$ROOT_DIR/server/gateway"
  npm ci
)

if command -v flatc >/dev/null 2>&1; then
  echo "[bootstrap] flatc detected — refreshing protocol codegen"
  "$ROOT_DIR/scripts/generate_protocol.sh"
else
  echo "[bootstrap] flatc not found — keeping committed generated protocol artifacts"
  echo "[bootstrap] install flatbuffers compiler if you want local protocol regeneration"
fi

echo "[bootstrap] done"
echo "[bootstrap] next: ./scripts/check.sh"
