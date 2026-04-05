#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIR="$ROOT_DIR/client/web"
GATEWAY_DIR="$ROOT_DIR/server/gateway"
SERVER_BUILD_DIR="$ROOT_DIR/server/build"

need_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[check] missing required command: $cmd" >&2
    exit 1
  fi
}

have_any_cxx() {
  command -v c++ >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1 || command -v clang++ >/dev/null 2>&1
}

run_step() {
  local label="$1"
  shift
  echo
  echo "[check] >>> $label"
  "$@"
}

need_cmd node
need_cmd npm
need_cmd cmake
need_cmd git

if ! have_any_cxx; then
  echo "[check] missing C++ compiler (need one of: c++, g++, clang++)" >&2
  exit 1
fi

if [[ ! -d "$CLIENT_DIR/node_modules" || ! -d "$GATEWAY_DIR/node_modules" ]]; then
  echo "[check] dependencies missing — running bootstrap first"
  "$ROOT_DIR/scripts/bootstrap.sh"
fi

if command -v flatc >/dev/null 2>&1; then
  run_step "regenerate protocol" "$ROOT_DIR/scripts/generate_protocol.sh"

  if ! git -C "$ROOT_DIR" diff --quiet -- shared/protocol/generated client/web/src/netcode/gen; then
    echo "[check] generated protocol artifacts differ from HEAD." >&2
    git -C "$ROOT_DIR" --no-pager diff -- shared/protocol/generated client/web/src/netcode/gen >&2 || true

    if [[ "${CI:-}" == "true" ]]; then
      echo "[check] CI requires committed/generated protocol artifacts to be in sync." >&2
      exit 1
    else
      echo "[check] local run: continuing, but remember to include regenerated files in your commit." >&2
    fi
  fi
else
  echo "[check] flatc not found — skipping protocol regeneration consistency check"
fi

run_step "client build" npm --prefix "$CLIENT_DIR" run build
run_step "client unit/integration tests" npm --prefix "$CLIENT_DIR" test
run_step "level validation" npm --prefix "$CLIENT_DIR" run level:validate

run_step "gateway syntax check" node --check "$ROOT_DIR/server/gateway/src/control_gateway_server.mjs"
run_step "gateway smoke syntax check" node --check "$ROOT_DIR/server/gateway/scripts/smoke_control_flow.mjs"

run_step "configure room server" cmake -S "$ROOT_DIR/server" -B "$SERVER_BUILD_DIR"
run_step "build room server" cmake --build "$SERVER_BUILD_DIR" -j 2

echo
printf '[check] all checks passed\n'
