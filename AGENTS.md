# AGENTS.md

Wildpaw Arena is an **integrated, harness-first webgame development repository**.
Treat it as an implementation repo with specs, not as a docs dump.

## Repo intent

Build and iterate on a web-native, authoritative multiplayer game with:
- `client/web` — playable web client / UI / gameplay prototype
- `server` — authoritative room server + control gateway
- `shared` — shared protocol + gameplay data
- root numbered `*.md` files — game/product/feature specs that explain intent

## Canonical read order

Start here when you enter the repo:
1. `STATUS.md`
2. `README.md`
3. task-specific area README/specs

Then branch by task type.

### If the task is client/web
Read in this order:
1. `client/web/README.md`
2. `07_클라이언트_구현_상세가이드.md`
3. `18_캐릭터_무기_전투_클라이언트_개발계획서.md`
4. `23_레벨_블록아웃_기반_클라이언트_개발명세서_및_계획서.md`

### If the task is room server / gateway / backend
Read in this order:
1. `server/README.md`
2. `server/SERVER_SPEC.md`
3. `server/gateway/README.md`
4. `20_게임플로우_API_이벤트_서버계약서.md`

### If the task is protocol / wire format / client-server contract
Read in this order:
1. `shared/protocol/README.md`
2. `shared/protocol/fbs/wildpaw_protocol.fbs`
3. `20_게임플로우_API_이벤트_서버계약서.md`
4. `server/README.md`
5. `client/web/README.md`

## What is low-priority / non-canonical

- root `docs/` is currently **borrowed / temporary reference material**.
- Do **not** treat root `docs/` as the source of truth for core implementation unless a task explicitly points there.
- `assets/x/` is reference/support material, not a primary gameplay implementation area.

## Repo map

- `client/web/src/app`, `src/ui`, `src/render`, `src/ecs`, `src/net`
  - active web-client implementation areas
- `client/web/scripts`
  - local dev/smoke/benchmark utilities
- `server/room`
  - authoritative room server
- `server/gateway`
  - control channel / queue / draft / match assign
- `shared/protocol`
  - schema-first networking contract
- `shared/data`
  - shared gameplay balance/config data

## Working rules

1. **Prefer schema-first changes.**
   - If protocol changes, edit `shared/protocol/fbs/wildpaw_protocol.fbs` first.
   - Then regenerate artifacts with `./scripts/generate_protocol.sh`.

2. **Do not hand-edit generated protocol artifacts unless absolutely necessary.**
   - Generated outputs live under:
     - `shared/protocol/generated/`
     - `client/web/src/netcode/gen/`

3. **Keep implementation and validation coupled.**
   - After meaningful changes, run:
     - `./scripts/check.sh`
     - `./scripts/smoke.sh` for integration-sensitive work

4. **Keep changes scoped.**
   - Avoid broad repo-wide refactors unless the task explicitly asks for them.
   - Prefer small, inspectable diffs.

5. **Prefer code-adjacent readmes over distant narrative docs.**
   - For implementation, trust `client/web/README.md`, `server/README.md`, `shared/protocol/README.md`, and nearby scripts/specs first.

## Common commands

### First-time bootstrap
```bash
./scripts/bootstrap.sh
```

### Full local check
```bash
./scripts/check.sh
```

### Integration smoke
```bash
./scripts/smoke.sh
```

### Regenerate shared protocol artifacts
```bash
./scripts/generate_protocol.sh
```

### Client-only
```bash
npm --prefix client/web run build
npm --prefix client/web test
npm --prefix client/web run level:validate
```

### Gateway-only
```bash
npm --prefix server/gateway run start
npm --prefix server/gateway run smoke
```

### Server-only
```bash
cmake -S server -B server/build
cmake --build server/build -j
```

## Definition of done

For implementation changes, aim to leave the repo in a state where:
- build/test commands still work
- generated protocol files are in sync when schema changed
- changed area README/spec links still make sense
- smoke passed if the change touched integration boundaries
