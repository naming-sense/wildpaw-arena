#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
LOG_DIR="$RUN_DIR/logs"
WEB_PID_FILE="$RUN_DIR/web.pid"
WS_PID_FILE="$RUN_DIR/ws.pid"
GATEWAY_PID_FILE="$RUN_DIR/gateway.pid"
WEB_PORT=4173
WS_PORT=8080
WS_ADMIN_PORT="${WS_ADMIN_PORT:-9100}"
WS_BACKEND="${WS_BACKEND:-cpp}"  # mock fallback intentionally disabled (cpp only)
GATEWAY_PORT=7200
GATEWAY_DIR="$(cd "$ROOT_DIR/../../server/gateway" && pwd)"
ROOM_BUILD_DIR="$(cd "$ROOT_DIR/../../server/build/room" && pwd)"
ROOM_BINARY="$ROOM_BUILD_DIR/wildpaw-room"
ROOM_RULES_PATH="$(cd "$ROOT_DIR/../../server/room/config" && pwd)/combat_rules.json"
ROOM_MAP_DATA_ROOT="$(cd "$ROOT_DIR/src/level/data/maps" && pwd)"

mkdir -p "$RUN_DIR" "$LOG_DIR"

port_pid() {
  local port="$1"
  ss -ltnp 2>/dev/null | awk -v p=":$port" '
    $4 ~ p {
      if (match($NF, /pid=[0-9]+/)) {
        pid = substr($NF, RSTART + 4, RLENGTH - 4)
        print pid
        exit
      }
    }
  '
}

is_running_pid() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

wait_port() {
  local port="$1"
  local retries="${2:-25}"
  local i
  for ((i=0; i<retries; i++)); do
    if [[ -n "$(port_pid "$port")" ]]; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

kill_port() {
  local port="$1" name="$2"
  local pid
  pid="$(port_pid "$port")"
  if [[ -z "$pid" ]]; then
    echo "[$name] not running"
    return
  fi

  kill "$pid" 2>/dev/null || true
  sleep 0.4
  if is_running_pid "$pid"; then
    kill -9 "$pid" 2>/dev/null || true
  fi
  echo "[$name] stopped (pid=$pid, port=$port)"
}

start_web() {
  local pid
  pid="$(port_pid "$WEB_PORT")"
  if [[ -n "$pid" ]]; then
    echo "[web] already running (pid=$pid, port=$WEB_PORT)"
    echo "$pid" > "$WEB_PID_FILE"
    return
  fi

  nohup bash -lc "cd '$ROOT_DIR' && exec ./node_modules/.bin/vite preview --host 0.0.0.0 --port $WEB_PORT --strictPort" \
    >"$LOG_DIR/web.log" 2>&1 &

  if ! wait_port "$WEB_PORT" 30; then
    echo "[web] failed to start (port $WEB_PORT not opened)" >&2
    return 1
  fi

  pid="$(port_pid "$WEB_PORT")"
  echo "$pid" > "$WEB_PID_FILE"
  echo "[web] started pid=$pid"
}

pick_ws_admin_port() {
  if [[ -z "$(port_pid "$WS_ADMIN_PORT")" ]]; then
    echo "$WS_ADMIN_PORT"
    return 0
  fi

  local candidate
  for candidate in 19100 19101 19102 19103 19104 19105; do
    if [[ -z "$(port_pid "$candidate")" ]]; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

start_ws() {
  local pid
  pid="$(port_pid "$WS_PORT")"
  if [[ -n "$pid" ]]; then
    echo "[ws] already running (pid=$pid, port=$WS_PORT)"
    echo "$pid" > "$WS_PID_FILE"
    return
  fi

  local admin_port
  if ! admin_port="$(pick_ws_admin_port)"; then
    echo "[ws] failed to start (no available admin port; WS_ADMIN_PORT=$WS_ADMIN_PORT is busy)" >&2
    return 1
  fi

  if [[ "$admin_port" != "$WS_ADMIN_PORT" ]]; then
    echo "[ws] admin port $WS_ADMIN_PORT is busy -> fallback $admin_port"
  fi

  if [[ "$WS_BACKEND" != "cpp" ]]; then
    echo "[ws] unsupported WS_BACKEND=$WS_BACKEND (mock backend disabled)" >&2
    return 1
  fi

  if [[ ! -x "$ROOM_BINARY" ]]; then
    echo "[ws] cpp backend required but binary missing: $ROOM_BINARY" >&2
    return 1
  fi

  nohup bash -lc "cd '$ROOM_BUILD_DIR' && WILDPAW_ROOM_TOKEN_SECRET='${WILDPAW_ROOM_TOKEN_SECRET:-dev-room-secret}' WILDPAW_ADMIN_TOKEN='${WILDPAW_ADMIN_TOKEN:-}' exec '$ROOM_BINARY' '$WS_PORT' 2 30 '$admin_port' '$ROOM_RULES_PATH' 3 '$ROOM_MAP_DATA_ROOT'" \
    >"$LOG_DIR/ws.log" 2>&1 &

  if ! wait_port "$WS_PORT" 30; then
    echo "[ws] failed to start (port $WS_PORT not opened)" >&2
    return 1
  fi

  pid="$(port_pid "$WS_PORT")"
  echo "$pid" > "$WS_PID_FILE"
  echo "[ws] started pid=$pid (backend=$WS_BACKEND, admin_port=$admin_port)"
}

ensure_gateway_dependencies() {
  if [[ -d "$GATEWAY_DIR/node_modules/ws" ]]; then
    return
  fi

  echo "[gateway] installing dependencies..."
  (cd "$GATEWAY_DIR" && npm install >/dev/null)
}

start_gateway() {
  local pid
  pid="$(port_pid "$GATEWAY_PORT")"
  if [[ -n "$pid" ]]; then
    echo "[gateway] already running (pid=$pid, port=$GATEWAY_PORT)"
    echo "$pid" > "$GATEWAY_PID_FILE"
    return
  fi

  ensure_gateway_dependencies

  nohup bash -lc "cd '$GATEWAY_DIR' && ROOM_ENDPOINT=\"ws://127.0.0.1:$WS_PORT\" ROOM_REGION=KR exec npm run start" \
    >"$LOG_DIR/gateway.log" 2>&1 &

  if ! wait_port "$GATEWAY_PORT" 35; then
    echo "[gateway] failed to start (port $GATEWAY_PORT not opened)" >&2
    return 1
  fi

  pid="$(port_pid "$GATEWAY_PORT")"
  echo "$pid" > "$GATEWAY_PID_FILE"
  echo "[gateway] started pid=$pid"
}

status_one() {
  local port="$1" file="$2" name="$3"
  local pid
  pid="$(port_pid "$port")"
  if [[ -n "$pid" ]]; then
    echo "$pid" > "$file"
    echo "[$name] running pid=$pid (port=$port)"
  else
    rm -f "$file"
    echo "[$name] stopped"
  fi
}

show_logs() {
  echo "--- web.log ---"
  tail -n 120 "$LOG_DIR/web.log" 2>/dev/null || true
  echo "--- ws.log ---"
  tail -n 120 "$LOG_DIR/ws.log" 2>/dev/null || true
  echo "--- gateway.log ---"
  tail -n 120 "$LOG_DIR/gateway.log" 2>/dev/null || true
}

cmd="${1:-start}"
case "$cmd" in
  start)
    start_web
    start_ws
    start_gateway
    ;;
  stop)
    kill_port "$WEB_PORT" "web"
    kill_port "$WS_PORT" "ws"
    kill_port "$GATEWAY_PORT" "gateway"
    rm -f "$WEB_PID_FILE" "$WS_PID_FILE" "$GATEWAY_PID_FILE"
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  status)
    status_one "$WEB_PORT" "$WEB_PID_FILE" "web"
    status_one "$WS_PORT" "$WS_PID_FILE" "ws"
    status_one "$GATEWAY_PORT" "$GATEWAY_PID_FILE" "gateway"
    ;;
  logs)
    show_logs
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}" >&2
    exit 1
    ;;
esac
