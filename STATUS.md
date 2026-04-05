# STATUS.md

## Repository identity

This repository is the **Wildpaw Arena integrated webgame development repo**.
It is **not** a docs-only repository.

Primary goal:
- build a harness-friendly, end-to-end webgame stack
- keep specs, shared protocol, client, and server in one working repo
- make agent work reproducible through clear entrypoints and validation commands

Practical interpretation:
- root numbered `*.md` files describe product / system intent
- `client/web`, `server`, and `shared` are the implementation backbone
- `scripts/` is the harness entrypoint layer

## Canonical source-of-truth areas

### Highest priority
- `client/web/`
- `server/`
- `shared/`
- `scripts/`
- root numbered feature/spec documents relevant to the task

### Lower priority / reference only
- root `docs/`
  - temporary borrowed/reference material
  - not the default source of truth for implementation work
- `assets/x/`
  - support/reference visuals, not core runtime logic

## Read-path by task

### Gameplay / client work
1. `client/web/README.md`
2. `07_클라이언트_구현_상세가이드.md`
3. task-relevant root spec docs

### Server / backend work
1. `server/README.md`
2. `server/SERVER_SPEC.md`
3. `server/gateway/README.md`
4. `20_게임플로우_API_이벤트_서버계약서.md`

### Protocol / networking work
1. `shared/protocol/README.md`
2. `shared/protocol/fbs/wildpaw_protocol.fbs`
3. `server/README.md`
4. `client/web/README.md`

## Harness entrypoints

### Bootstrap
```bash
./scripts/bootstrap.sh
```
Installs JS dependencies and refreshes protocol codegen when `flatc` is available.

### Check
```bash
./scripts/check.sh
```
Runs the main local validation path:
- protocol generation/sync check
- client build/test/level validation
- gateway syntax check
- room server build

### Smoke
```bash
./scripts/smoke.sh
```
Runs lightweight integration smoke using:
- mock room server
- control gateway
- gateway smoke script

## Implementation conventions

- Prefer **schema-first** changes for network contracts.
- Prefer **code-adjacent** documentation over distant narrative docs.
- Keep generated artifacts in sync:
  - `shared/protocol/generated/`
  - `client/web/src/netcode/gen/`
- Keep integration checks runnable from the repo root.

## Near-term harness posture

Current state:
- repo already has good implementation density
- local scripts and specs exist
- root harness layer is now expected to be the stable operator entrypoint

Desired posture:
- one repo-level bootstrap command
- one repo-level check command
- one repo-level smoke command
- CI calling the same commands humans/agents use locally

## Naming note

The current GitHub repository name still ends with `-design-docs`, but the repo has already outgrown that name.
Operationally, treat it as **Wildpaw Arena integrated development repo**.
