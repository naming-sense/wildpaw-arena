#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA="$ROOT_DIR/shared/protocol/fbs/wildpaw_protocol.fbs"
CPP_OUT="$ROOT_DIR/shared/protocol/generated/cpp"
TS_OUT="$ROOT_DIR/client/web/src/netcode/gen"

mkdir -p "$CPP_OUT" "$TS_OUT"

flatc --cpp --scoped-enums -o "$CPP_OUT" "$SCHEMA"
flatc --ts -o "$TS_OUT" "$SCHEMA"

# flatc's TS output can introduce unused imports/generics that trip this repo's
# strict TypeScript settings (`noUnusedLocals`, `noUnusedParameters`). Normalize
# the generated file so repo-level build/check remains stable across flatc versions.
TS_OUT="$TS_OUT" python3 - <<'PY'
import os
from pathlib import Path

path = Path(os.environ["TS_OUT"]) / "wildpaw/protocol/envelope.ts"
if path.exists():
    text = path.read_text(encoding="utf-8")
    text = text.replace(
        "import { MessagePayload, unionToMessagePayload, unionListToMessagePayload } from '../../wildpaw/protocol/message-payload';",
        "import { MessagePayload } from '../../wildpaw/protocol/message-payload';",
    )
    text = text.replace(
        "payload<T extends flatbuffers.Table>(obj:any):any|null {",
        "payload(obj:any):any|null {",
    )
    path.write_text(text, encoding="utf-8")
PY

echo "Generated FlatBuffers protocol artifacts:"
echo "- $CPP_OUT"
echo "- $TS_OUT"
