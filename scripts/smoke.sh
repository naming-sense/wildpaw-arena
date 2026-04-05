#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIR="$ROOT_DIR/client/web"
GATEWAY_DIR="$ROOT_DIR/server/gateway"
SERVER_DIR="$ROOT_DIR/server"
ROOM_BINARY="$ROOT_DIR/server/build/room/wildpaw-room"
ROOM_RULES="$ROOT_DIR/server/room/config/combat_rules.json"

ROOM_PORT="${ROOM_PORT:-17001}"
ROOM_ADMIN_PORT="${ROOM_ADMIN_PORT:-19100}"
GATEWAY_PORT="${GATEWAY_PORT:-17200}"
SMOKE_CLIENTS="${SMOKE_CLIENTS:-6}"
ROOM_TEAM_SIZE="${ROOM_TEAM_SIZE:-3}"

ROOM_PID=""
GATEWAY_PID=""
LOG_DIR="$(mktemp -d)"
ROOM_LOG="$LOG_DIR/room.log"
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

resolve_port() {
  local requested="$1"
  local name="$2"
  local port="$requested"

  while port_busy "$port"; do
    port=$((port + 1))
  done

  if [[ "$port" != "$requested" ]]; then
    echo "[smoke] $name port $requested busy -> using $port" >&2
  fi

  printf '%s' "$port"
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
    echo "--- room.log ---"
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
need_cmd cmake

if [[ ! -d "$CLIENT_DIR/node_modules" || ! -d "$GATEWAY_DIR/node_modules" ]]; then
  echo "[smoke] dependencies missing — running bootstrap first"
  "$ROOT_DIR/scripts/bootstrap.sh"
fi

ROOM_PORT="$(resolve_port "$ROOM_PORT" room)"
ROOM_ADMIN_PORT="$(resolve_port "$ROOM_ADMIN_PORT" room_admin)"
while [[ "$ROOM_ADMIN_PORT" == "$ROOM_PORT" ]]; do
  ROOM_ADMIN_PORT="$(resolve_port "$((ROOM_ADMIN_PORT + 1))" room_admin)"
done
GATEWAY_PORT="$(resolve_port "$GATEWAY_PORT" gateway)"
while [[ "$GATEWAY_PORT" == "$ROOM_PORT" || "$GATEWAY_PORT" == "$ROOM_ADMIN_PORT" ]]; do
  GATEWAY_PORT="$(resolve_port "$((GATEWAY_PORT + 1))" gateway)"
done

if [[ ! -x "$ROOM_BINARY" ]]; then
  echo "[smoke] room binary missing — building it first"
  cmake -S "$SERVER_DIR" -B "$ROOT_DIR/server/build"
  cmake --build "$ROOT_DIR/server/build" -j 2
fi

if [[ ! -f "$ROOM_RULES" ]]; then
  echo "[smoke] missing room rules file: $ROOM_RULES" >&2
  exit 1
fi

echo "[smoke] starting room server on ws://127.0.0.1:$ROOM_PORT"
(
  cd "$SERVER_DIR"
  "$ROOM_BINARY" "$ROOM_PORT" 2 30 "$ROOM_ADMIN_PORT" "$ROOM_RULES" "$ROOM_TEAM_SIZE"
) >"$ROOM_LOG" 2>&1 &
ROOM_PID=$!

if ! wait_port "$ROOM_PORT" 120; then
  echo "[smoke] room server failed to open port $ROOM_PORT" >&2
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

echo "[smoke] running room capacity smoke"
(
  cd "$CLIENT_DIR"
  npx tsx ./scripts/room-capacity-smoke.ts "ws://127.0.0.1:$ROOM_PORT" 7 2500
)

echo "[smoke] running gateway smoke with $SMOKE_CLIENTS clients"
(
  cd "$GATEWAY_DIR"
  GATEWAY_URL="ws://127.0.0.1:$GATEWAY_PORT" SMOKE_CLIENTS="$SMOKE_CLIENTS" npm run smoke
)

echo "[smoke] smoke passed"
