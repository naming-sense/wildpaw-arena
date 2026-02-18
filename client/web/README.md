# client/web

`client/web`는 현재 **두 트랙**을 함께 담고 있습니다.

1. 기존 netcode/gameplay 스캐폴드(`src/netcode`, `src/gameplay` 일부)
2. 실제 실행 가능한 Vite+React+Three.js 프로토타입(`src/app`, `src/net`, `src/ecs`, `src/render`)

---

## 현재 구현 범위 (실행형 프로토타입)

- Vite + TypeScript(strict) + React + Three.js + Zustand
- Render/Simulation 루프 분리
  - Render: `requestAnimationFrame`
  - Simulation: `33.33ms (30Hz)` 고정 스텝
- ECS 골격
  - Component: `Transform`, `Velocity`, `Health`, `Team`, `Weapon`, `SkillSet`, `StatusEffect`, `RenderProxy`
  - System: Input → Movement → Collision → WeaponFire → Projectile → Skill → BuffDebuff → Animation
  - 렌더 보간: `GameApp.syncRenderProxies()`에서 프레임 단위 보간
- Netcode 구현
  - `InputCommand` + 로컬 prediction/reconciliation
  - remote snapshot interpolation + dead reckoning(extrapolation)
  - server time offset(clock skew) 보정 샘플링
  - 재접속 상태머신 + persistent `clientId`
- 디버그/운영 지표
  - FPS / frame time / draw calls
  - ping / jitter / packet loss
  - replay logger
- 게임플로우 제어 채널(20 계약서 기반) 클라이언트
  - `src/flow/controlFlowClient.ts`
  - Envelope: `event/eventId/requestId/sessionId/ts/payload`
  - AppFlowState: `BOOT/AUTH/ONBOARDING/LOBBY/QUEUEING/READY_CHECK/DRAFT/MATCH_LOADING/IN_MATCH/RESULT/...`
  - UI 패널: `src/ui/lobby/LobbyView.tsx` (Flow Control Overlay)

## Gateway Control Channel 연동

기본 endpoint 해석:
- `ws://<현재호스트>:7200` (https면 `wss`)

명시 오버라이드:

```bash
VITE_GATEWAY_WS_URL=ws://127.0.0.1:7200 npm run dev
```

Flow Overlay에서 제공하는 동작:
- BOOT_READY / AUTH_GUEST / ONBOARDING_COMPLETE
- QUEUE_JOIN / QUEUE_CANCEL
- MATCH_ACCEPT
- DRAFT_PICK
- ROOM_CONNECT_OK/FAIL
- REMATCH_YES

> 현재는 계약서 검증용 구현으로, 전투 room socket 자동 전환(매치할당 endpoint로 즉시 스위치)은 다음 단계에서 고도화합니다.

## 모델/애니메이션 QA

- 전용 페이지: `/model-lab.html`
- 게임 루프와 분리해 GLB/clip/skeleton/bounds/timeline 검증
- 상세 문서:
  - `docs/MODEL_ANIMATION_TEST_PAGE.md`
  - `docs/IMPLEMENTATION_HISTORY_2026-02.md`

## 운영 스크립트 (개발/테스트)

```bash
./scripts/run_services_detached.sh start
./scripts/run_services_detached.sh status
./scripts/run_services_detached.sh logs
./scripts/run_services_detached.sh restart
./scripts/run_services_detached.sh stop
```

- web preview: `0.0.0.0:4173`
- mock ws room: `0.0.0.0:8080`
- runtime 로그/상태: `client/web/.run/`

## 실행

```bash
cd client/web
npm install
npm run dev
```

빌드/테스트:

```bash
npm run build
npm test
```

---

## 기존 netcode/gameplay 스캐폴드 (legacy track)

`src/netcode` + `src/gameplay`의 일부 유틸은 초기 설계/호환 레이어로 유지됩니다.

- `src/netcode`
  - `types.ts`: snapshot/input/combat-event 타입 alias
  - `prediction.ts`: prediction/reconcile bridge
  - `interpolation.ts`: interpolation buffer bridge
  - `netClient.ts`: realtime client bridge
- 향후 `shared/protocol` 확정(FlatBuffers/bitpack) 시 교체 대상

스모크 테스트 예시(서버 준비 후):

```bash
cd client/web
npx tsx ./scripts/bench-room.ts --url ws://127.0.0.1:7001 --clients 40 --duration-ms 4000 --input-interval-ms 50
npx tsx ./scripts/ecs-runtime-smoke.ts ws://127.0.0.1:7001 ecs-smoke
npx tsx ./scripts/interest-filter-smoke.ts ws://127.0.0.1:7001
npx tsx ./scripts/profile-rules-smoke.ts ws://127.0.0.1:7001
npx tsx ./scripts/profile-select-smoke.ts ws://127.0.0.1:7001 skirmisher
```
