#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA="$ROOT_DIR/shared/protocol/fbs/wildpaw_protocol.fbs"
CPP_OUT="$ROOT_DIR/shared/protocol/generated/cpp"
TS_OUT="$ROOT_DIR/client/web/src/netcode/gen"

mkdir -p "$CPP_OUT" "$TS_OUT"

flatc --cpp --scoped-enums -o "$CPP_OUT" "$SCHEMA"
flatc --ts -o "$TS_OUT" "$SCHEMA"

echo "Generated FlatBuffers protocol artifacts:"
echo "- $CPP_OUT"
echo "- $TS_OUT"
