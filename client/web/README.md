# client/web netcode + gameplay scaffold

Three.js 클라이언트에 붙일 netcode/게임루프 스캐폴드입니다.

## 포함 모듈

### netcode (`src/netcode`)
- `types.ts`: snapshot/input/combat-event 타입
- `prediction.ts`: 로컬 예측/복구
- `interpolation.ts`: 원격 플레이어 보간 버퍼
- `netClient.ts`: FlatBuffers 기반 realtime transport
  - C2S binary envelope 송신 (`HELLO/ACTION_COMMAND/SELECT_PROFILE/PING`, `INPUT` 하위호환)
  - S2C binary envelope 수신 (`WELCOME/SNAPSHOT/COMBAT_EVENT/PROJECTILE_EVENT/EVENT`)
  - `seq/ack/ackBits` 자동 추적
  - 중복 envelope(seq) 수신 방지(dedup)
- `src/netcode/gen/*`: flatc로 생성된 TS 코드

### gameplay (`src/gameplay`)
- `ecs/realtimeEcsRuntime.ts`
  - `RealtimeClient` + prediction/reconciliation + interpolation 결합
  - 입력 송신(`sendInput`) / 렌더 스텝(`step`) 통합
  - HUD 상태(탄약/재장전/스킬 쿨다운/캐스팅) 콜백 제공
  - 옵션 `profileId` 지정 시 접속 직후 `SELECT_PROFILE` 자동 요청
- `three/threeCombatSceneAdapter.ts`
  - 스냅샷 기반 플레이어 Mesh 동기화
  - combat/projectile 이벤트 FX 기본 구현
- `three/threeRealtimeLoop.ts`
  - `requestAnimationFrame` 기반 렌더 루프 + 20Hz 입력 루프 결합

## 의존성 설치
```bash
cd client/web
npm install
```

## 통합 순서 (M1+)
1. 렌더 초기화 후 `ThreeCombatSceneAdapter` 생성
2. `startThreeRealtimeLoop()`로 네트워크/입력/렌더 루프 연결
3. 입력 샘플러(`sampleInput`)에서 `move/fire/skillQ/E/R` 상태 반환

```ts
const stop = startThreeRealtimeLoop({
  roomToken: "dev-room",
  profileId: "skirmisher",
  url: "ws://127.0.0.1:7001",
  renderer,
  scene,
  camera,
  sampleInput: () => ({
    moveX: inputAxis.x,
    moveY: inputAxis.y,
    fire: mouse.left,
    aimRadian,
    skillQ: keyQ,
    skillE: keyE,
    skillR: keyR,
  }),
});
```

## 스모크 테스트 스크립트
서버 기동 후 아래 스크립트로 연결/이벤트/룰 반영을 빠르게 확인할 수 있습니다.

```bash
cd client/web
# 기본 부하
npx tsx ./scripts/bench-room.ts --url ws://127.0.0.1:7001 --clients 40 --duration-ms 4000 --input-interval-ms 50

# ECS runtime + HUD 상태 확인
npx tsx ./scripts/ecs-runtime-smoke.ts ws://127.0.0.1:7001 ecs-smoke

# combat/projectile interest filtering 확인
npx tsx ./scripts/interest-filter-smoke.ts ws://127.0.0.1:7001

# 프로필별 룰(maxAmmo 등) 분리 확인
npx tsx ./scripts/profile-rules-smoke.ts ws://127.0.0.1:7001

# SELECT_PROFILE 패킷 적용 확인
npx tsx ./scripts/profile-select-smoke.ts ws://127.0.0.1:7001 skirmisher
```
