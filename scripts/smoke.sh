#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIR="$ROOT_DIR/client/web"
GATEWAY_DIR="$ROOT_DIR/server/gateway"

ROOM_PORT="${ROOM_PORT:-18080}"
ROOM_ADMIN_PORT="${ROOM_ADMIN_PORT:-19100}"
GATEWAY_PORT="${GATEWAY_PORT:-17200}"
SMOKE_CLIENTS="${SMOKE_CLIENTS:-6}"

ROOM_PID=""
GATEWAY_PID=""
LOG_DIR="$(mktemp -d)"
ROOM_LOG="$LOG_DIR/mock-room.log"
GATEWAY_LOG="$LOG_DIR/gateway.log"

need_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[smoke] missing required command: $cmd" >&2
    exit 1
  fi
}

port_busy() {
  local port="$1"
  (echo >"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1
}

wait_port() {
  local port="$1"
  local retries="${2:-100}"
  local i

  for ((i=0; i<retries; i++)); do
    if port_busy "$port"; then
      return 0
    fi
    sleep 0.1
  done

  return 1
}

ensure_port_free() {
  local port="$1"
  local name="$2"

  if port_busy "$port"; then
    echo "[smoke] port $port is already in use for $name" >&2
    echo "[smoke] override with ${name^^}_PORT=<free-port> if needed" >&2
    exit 1
  fi
}

cleanup() {
  local exit_code=$?

  if [[ -n "$GATEWAY_PID" ]] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill "$GATEWAY_PID" 2>/dev/null || true
    wait "$GATEWAY_PID" 2>/dev/null || true
  fi

  if [[ -n "$ROOM_PID" ]] && kill -0 "$ROOM_PID" 2>/dev/null; then
    kill "$ROOM_PID" 2>/dev/null || true
    wait "$ROOM_PID" 2>/dev/null || true
  fi

  if [[ $exit_code -ne 0 ]]; then
    echo
    echo "[smoke] failed — logs follow"
    echo "--- mock-room.log ---"
    tail -n 200 "$ROOM_LOG" 2>/dev/null || true
    echo "--- gateway.log ---"
    tail -n 200 "$GATEWAY_LOG" 2>/dev/null || true
    echo "[smoke] temp logs kept at: $LOG_DIR"
  else
    rm -rf "$LOG_DIR"
  fi

  exit "$exit_code"
}

trap cleanup EXIT INT TERM

need_cmd node
need_cmd npm

if [[ ! -d "$CLIENT_DIR/node_modules" || ! -d "$GATEWAY_DIR/node_modules" ]]; then
  echo "[smoke] dependencies missing — running bootstrap first"
  "$ROOT_DIR/scripts/bootstrap.sh"
fi

ensure_port_free "$ROOM_PORT" room
ensure_port_free "$ROOM_ADMIN_PORT" room_admin
ensure_port_free "$GATEWAY_PORT" gateway

echo "[smoke] starting mock room on ws://127.0.0.1:$ROOM_PORT"
(
  cd "$CLIENT_DIR"
  PORT="$ROOM_PORT" ADMIN_PORT="$ROOM_ADMIN_PORT" node ./scripts/mock-room-server.mjs
) >"$ROOM_LOG" 2>&1 &
ROOM_PID=$!

if ! wait_port "$ROOM_PORT" 120; then
  echo "[smoke] mock room failed to open port $ROOM_PORT" >&2
  exit 1
fi

echo "[smoke] starting gateway on ws://127.0.0.1:$GATEWAY_PORT"
(
  cd "$GATEWAY_DIR"
  CONTROL_PORT="$GATEWAY_PORT" ROOM_ENDPOINT="ws://127.0.0.1:$ROOM_PORT" npm run start
) >"$GATEWAY_LOG" 2>&1 &
GATEWAY_PID=$!

if ! wait_port "$GATEWAY_PORT" 120; then
  echo "[smoke] gateway failed to open port $GATEWAY_PORT" >&2
  exit 1
fi

echo "[smoke] running gateway smoke with $SMOKE_CLIENTS clients"
(
  cd "$GATEWAY_DIR"
  GATEWAY_URL="ws://127.0.0.1:$GATEWAY_PORT" SMOKE_CLIENTS="$SMOKE_CLIENTS" npm run smoke
)

echo "[smoke] smoke passed"
