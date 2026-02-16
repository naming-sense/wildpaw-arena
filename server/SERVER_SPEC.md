# Wildpaw Room Server 구현 스펙 (현재 구현 기준)

> 이 문서는 `server/room`에 **실제로 구현된 코드**를 기준으로 한 서버 스펙입니다.
>
> - 설계/배경 문서: `../04_서버_네트워크_아키텍처.md`
> - 실행 착수본: `../07_실행_스캐폴드_가이드.md`
> - 프로토콜(SSoT): `../shared/protocol/fbs/wildpaw_protocol.fbs`

---

## 0) 범위(What’s implemented)

### 포함(현재 구현됨)
- C++20 + Boost.Asio/Beast 기반 **WebSocket realtime room 서버**
- WebSocket **binary-only** 프레임
- FlatBuffers full-binary 프로토콜(Envelope + payload union)
- `seq/ack/ackBits` 기반 **retransmit(신뢰 전송) 큐**
- 서버 tick thread 분리 + `pendingInputs` drain
- `SnapshotBase/Delta` 브로드캐스트
- grid 기반 spatial **interest filtering** (snapshot + combat/projectile event)
- 샘플 authoritative combat(사격/스킬/데미지/다운) + projectile 이벤트
- `combat_rule_table` 룰 테이블(탄약/재장전/쿨다운/캐스트타임/데미지)
- 프로필(캐릭터/클래스) 선택 패킷(`SelectProfilePayload`)
- `combat_rules.json` **핫리로드**(파일 변경 감지)
- Prometheus `/metrics` 노출

### 제외(아직 미구현)
- Gateway/Matchmaker 실코드(인증/매칭/입장 토큰 검증)
- TLS, 실서비스 보안(서명/암호화/ratelimit/ban)
- lag compensation(리와인드), LOS 판정, 장애물/맵 충돌
- deterministic physics / 리플레이 / persistence(저장)

---

## 1) 디렉토리 & 소스 오브 트루스

- 서버 엔트리/루프: `room/src/main.cpp`
- 시뮬레이션: `room/src/room_simulation.cpp`
- 전송(FlatBuffers): `room/src/wire_flatbuffers.cpp`
- 관심영역: `room/src/interest_manager.cpp`
- 스냅샷 델타: `room/src/snapshot_builder.cpp`
- 신뢰 전송 ack 추적: `room/src/room_session.cpp`
- 전투 룰/프로필/JSON 로드: `room/src/combat_rule_table.cpp`
- 룰 설정 파일: `room/config/combat_rules.json`

---

## 2) 빌드/실행

### 2-1. 빌드
```bash
cd server
cmake -S . -B build
cmake --build build -j
```

### 2-2. 실행
```bash
./build/room/wildpaw-room [port] [io_threads] [tick_rate] [metrics_port] [rules_json_path]

# 예시
./build/room/wildpaw-room 7001 4 30 9100 room/config/combat_rules.json
```

- `port`: WebSocket listen (기본 7001)
- `io_threads`: `io_context` 워커 스레드 수
- `tick_rate`: 서버 틱(기본 30Hz)
- `metrics_port`: Prometheus endpoint (기본 9100)
- `rules_json_path`: 룰 JSON 경로(기본 `room/config/combat_rules.json`)

---

## 3) Transport (WebSocket)

- 서버는 WebSocket을 사용하며 **binary frame만** 정상 처리한다.
- text frame 수신 시 `S2C_EVENT(warn, binary-c2s-required)`로 경고 후 계속 read 한다.
- 클라에서는 `ws.binaryType = "arraybuffer"`가 필요하다.

---

## 4) FlatBuffers 프로토콜

### 4-1. Envelope
- schema: `shared/protocol/fbs/wildpaw_protocol.fbs`
- file identifier: `"WPAR"`

Envelope 필드:
- `seq:uint`
- `ack:uint`
- `ack_bits:uint`
- `payload: MessagePayload (union)`

### 4-2. C2S payload
- `HelloPayload(room_token, client_version)`
- `ActionCommandPayload(input_seq, move_x, move_y, fire, aim_radian, skill_q/e/r)` (권장)
- `SelectProfilePayload(profile_id)`
- `PingPayload()`
- `InputPayload(...)` (legacy-compat)

### 4-3. S2C payload
- `WelcomePayload(player_id, server_tick_rate, server_tick)`
- `SnapshotPayload(kind=Base|Delta, server_tick, server_time_ms, players[])`
- `CombatEventPayload`
- `ProjectileEventPayload`
- `EventPayload(name, message)`

### 4-4. Snapshot PlayerState(서버→클라 계약)
`SnapshotPayload.players[].PlayerState`는 아래 상태를 포함한다.
- 이동/체력: `position`, `velocity`, `hp`, `alive`, `last_processed_input_seq`
- 무기: `ammo`, `max_ammo`, `is_reloading`, `reload_remaining_ticks`
- 스킬: `skill_q/e/r_cooldown_ticks`
- 캐스팅: `casting_skill`, `cast_remaining_ticks`

---

## 5) 연결/핸드셰이크 플로우(현재)

1) Client → `C2S_HELLO`
2) Server → `S2C_WELCOME` (Critical reliable)
3) Server → `S2C_SNAPSHOT_BASE` (Critical reliable)
4) (선택) Client → `C2S_SELECT_PROFILE(profileId)`
5) Server → `profile.applied` 또는 `profile.invalid` (Standard reliable)
6) Client → `C2S_ACTION_COMMAND` 스트림 시작

서버는 접속 시점에 `playerId`를 부여(현재 1001부터 증가)하며,
스캐폴드 단계에서는 룰 프로필도 접속 순서 기반으로 기본 배정(라운드로빈)된다.

---

## 6) 스레드/루프 모델

### 6-1. 스레드 구성
- `io_context` 워커 스레드풀: `io_threads`
- tick 전용 스레드(`std::jthread`): 고정 주기(예: 30Hz)

### 6-2. 입력 파이프라인
- 네트워크 스레드에서 decode 후 `pendingInputs` 큐에 적재
- tick thread가 매 tick마다 `pendingInputs`를 drain 후 시뮬에 반영

`pendingInputs` 보호:
- mutex 보호
- 최대 `kMaxPendingInputFrames=100000`
- 초과 시 오래된 입력을 pop하여 drop 처리(메트릭 증가)

### 6-3. 세션 송신 순서
- 각 세션은 `strand + writeQueue` 기반으로 **in-order write**를 보장한다.

---

## 7) Tick 루프(고정 주기)

tick thread는 다음 순서를 반복한다.

1) (선택) 룰 JSON hot-reload 체크(1초 주기)
2) `pendingInputs` drain
3) 시뮬에 입력 push
4) `RoomSimulation.tick()`
5) `SnapshotBuilder.buildDelta()`
6) `drainCombatEvents()` / `drainProjectileEvents()`
7) interest filtering 후 snapshot delta + 이벤트 전송
8) 세션별 `pumpRetransmit()`

---

## 8) Snapshot delta

- `SnapshotBuilder`는 직전 tick의 `PlayerState`를 저장해두고,
  변경된 플레이어만 `changedPlayers`로 추린다.
- 변경 판단에는 위치/속도 epsilon + 체력/생존 + 입력 ack + 전투 HUD 필드(ammo/cd/cast 등)가 포함된다.

---

## 9) Reliable retransmit (seq/ack/ackBits)

### 9-1. outbound ack(서버→클라)
서버는 클라에서 수신한 `seq`를 기반으로 outbound envelope에
- `ack`: 가장 최신으로 수신한 client seq
- `ack_bits`: 직전 32개 범위 내 수신 여부 비트
를 포함한다.

### 9-2. inbound ack(클라→서버)
클라가 서버 패킷을 받은 여부는 client가 보내는 `ack/ackBits`로 판단한다.
서버는 미ack 패킷을 policy에 따라 재전송한다.

### 9-3. 정책
- `Critical`: timeout 180ms, retries 8
  - 예: `Welcome`, `SnapshotBase`
- `Standard`: timeout 120ms, retries 3
  - 예: `hello.ack`, `profile.applied/invalid`
- `BestEffort`: 재전송 없음
  - 예: `SnapshotDelta`, `CombatEvent`, `ProjectileEvent`, `pong/warn`

클라이언트는 **중복 envelope(seq)** 를 dedup하여,
재전송으로 동일 seq가 다시 들어와도 이벤트/스냅샷이 중복 처리되지 않도록 한다.

---

## 10) Interest Management(Spatial filtering)

### 10-1. Grid
- cell size 기본 8m
- 매 tick마다 현재 플레이어 위치로 grid rebuild

### 10-2. Snapshot filter
- viewer 기준 반경(현재 25m) 내 플레이어 + 자기 자신 포함
- delta snapshot은 visible 대상 중 changed 플레이어만 전송

### 10-3. Event filter
Combat/Projectile 이벤트는 아래 조건일 때만 viewer에게 전송한다.
- viewer == source/owner
- viewer == target
- viewer의 visible set에 source/target이 포함

필터로 제외된 이벤트는 카운터로 집계한다.

---

## 11) Combat simulation(샘플 authoritative)

> 목적: “전투 진행에 필요한 패킷/상태/이벤트”가 실제로 돌아가는 skeleton 제공.

- 이동: `moveX/moveY` 기반 단순 속도 + 월드 바운더리 clamp
- 사격: `fire` 유지 시 `fireIntervalTicks`마다 발사
  - ammo 소모, ammo==0이면 reload 시작
  - `ShotFired` + `Projectile(Spawn)` + (타겟 있으면) `DamageApplied` + `Projectile(Hit)`
- 스킬 입력(Q/E/R): rising-edge 트리거
  - 쿨다운/탄약 코스트/캐스트 타임 반영
  - `SkillCast` 이벤트 즉시 송신
  - 캐스트 종료 tick에서 효과 적용(Q=단일 타겟, R=AOE, E=placeholder)
- 피해/다운: HP 0 도달 시 `Knockout`

---

## 12) Combat rule table / 프로필 / JSON

### 12-1. 룰 테이블
`CombatRuleTable` 주요 필드:
- 무기: `maxAmmo`, `ammoPerShot`, `fireIntervalTicks`, `reloadTicks`, `shotRangeMeters`, `shotDamage`, `projectileSpeed`
- 스킬(Q/E/R): `cooldownTicks`, `castTimeTicks`, `damage`, `rangeMeters/radiusMeters`, `ammoCost`, `critical`

### 12-2. JSON 포맷
- 파일: `room/config/combat_rules.json`
- 구조:
  - `default_profile`: string
  - `profiles`: `{ [profileId]: CombatRuleTableLike }`

### 12-3. 핫리로드
- 서버는 `rules_json_path` 파일의 mtime을 1초 주기로 체크
- 변경 감지 시 `loadCombatRuleProfilesFromJson()` 재호출
- 성공/실패는 metrics로 집계

---

## 13) Prometheus metrics

endpoint:
- `http://127.0.0.1:<metrics_port>/metrics`

주요 지표:
- `wildpaw_room_active_sessions`
- `wildpaw_room_pending_input_queue_depth`
- `wildpaw_room_pending_input_queue_peak`
- `wildpaw_room_dropped_input_frames_total`
- `wildpaw_room_input_frames_total`
- `wildpaw_room_tick_total`
- `wildpaw_room_tick_overrun_total`
- `wildpaw_room_tick_last_duration_ms`
- `wildpaw_room_snapshot_base_sent_total`
- `wildpaw_room_snapshot_delta_sent_total`
- `wildpaw_room_event_sent_total`
- `wildpaw_room_combat_event_sent_total`
- `wildpaw_room_projectile_event_sent_total`
- `wildpaw_room_combat_event_filtered_total`
- `wildpaw_room_projectile_event_filtered_total`
- `wildpaw_room_rule_reload_success_total`
- `wildpaw_room_rule_reload_failure_total`
- `wildpaw_room_reliable_inflight_packets`
- `wildpaw_room_retransmit_sent_total`
- `wildpaw_room_retransmit_dropped_total`

---

## 14) Admin Dashboard / HTTP API

`metrics_port`는 `/metrics` 뿐 아니라 관리자 UI/API도 함께 제공한다.

- UI: `GET /admin/`
- API:
  - `GET /admin/api/status`
  - `GET /admin/api/sessions`
  - `GET /admin/api/violations`
  - `POST /admin/api/sessions/{playerId}/disconnect`
  - `POST /admin/api/rules/reload`

### 14-1. 인증
- 환경변수 `WILDPAW_ADMIN_TOKEN`이 설정되면 `/admin*` 경로는 인증 필요
- 전달 방식:
  - header: `x-admin-token: <token>`
  - 또는 query: `?token=<token>`
- 토큰 미설정 시(개발 모드) `/admin*` 인증 없이 접근 가능

### 14-2. Sessions API에 포함되는 운영 필드
- `playerId`
- `remote` (ip:port)
- `connectedAtMs`, `lastSeenAtMs`
- `bytesIn`, `bytesOut`
- `binaryFramesIn`, `textFramesIn`
- `invalidEnvelopeTotal`, `unsupportedMessageTotal`, `invalidProfileSelectTotal`
- `reliableInFlight`

### 14-3. Violations API
서버가 감지/기록하는 이벤트 예시:
- `c2s_text_frame`
- `invalid_envelope`
- `unsupported_message_type`
- `profile_invalid`
- `message_too_big`
- `admin_disconnect`
- `rules_reload_failed`

---

## 15) 벤치/스모크 테스트(현재 레포 포함)

```bash
# server
cd server
cmake -S . -B build
cmake --build build -j
WILDPAW_ADMIN_TOKEN=secret123 \
  ./build/room/wildpaw-room 7001 4 30 9100 room/config/combat_rules.json

# metrics
curl -s http://127.0.0.1:9100/metrics | head

# admin status/sessions
curl -s -H 'x-admin-token: secret123' http://127.0.0.1:9100/admin/api/status | head
curl -s -H 'x-admin-token: secret123' http://127.0.0.1:9100/admin/api/sessions | head

# client web scripts
cd client/web
npm install

# 부하(간이)
npx tsx ./scripts/bench-room.ts --url ws://127.0.0.1:7001 --clients 40 --duration-ms 4000 --input-interval-ms 50

# ECS runtime 연결/이벤트/HUD 확인
npx tsx ./scripts/ecs-runtime-smoke.ts ws://127.0.0.1:7001 ecs-smoke

# interest filtering 확인
npx tsx ./scripts/interest-filter-smoke.ts ws://127.0.0.1:7001

# 프로필별 룰 분리 확인
npx tsx ./scripts/profile-rules-smoke.ts ws://127.0.0.1:7001

# SELECT_PROFILE 적용 확인
npx tsx ./scripts/profile-select-smoke.ts ws://127.0.0.1:7001 skirmisher
```

---

## 16) Known gaps / 다음 TODO(구현 관점)

- lag compensation(리와인드) 미구현
- 장애물/맵 충돌/LOS 미구현
- 입력은 player별 최신 프레임 기반(현재) → 향후 `popUpTo()` 기반 리플레이/정밀 적용 가능
- 보안(TLS/JWT/ratelimit) 및 Gateway 검증 미구현
- interest filtering의 viewer별 visible set 계산 최적화(현재는 매 tick viewer마다 계산)
