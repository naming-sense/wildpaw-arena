# Wildpaw Server Scaffold (C++20 + Asio/Beast)

## 구성
- `room/`: 실시간 authoritative 룸 서버
  - WebSocket **binary-only** C2S/S2C
  - FlatBuffers Envelope decode/encode
  - `io_context` 멀티스레드 + `work_guard`
  - 전용 tick thread(고정주기) + `pendingInputs` 워커큐 drain
  - 세션별 `strand + write_queue`로 송신 순서 보장
  - ack 기반 reliable retransmit queue (유실 복구)
  - 메시지 타입별 정책(Critical/Standard/BestEffort)
  - `combat_rule_table` 기반 무기/스킬 룰(탄약/재장전/쿨다운/캐스트타임)
  - Prometheus `/metrics` 노출
  - grid 기반 spatial interest filtering (snapshot + combat/projectile event)
- `gateway/`: 인증/라우팅 계층 (TODO)
- `matchmaker/`: 매칭 계층 (TODO)

## 빌드 (room)
```bash
cd server
cmake -S . -B build
cmake --build build -j
```

## 실행
```bash
./build/room/wildpaw-room [port] [io_threads] [tick_rate] [metrics_port]

# 예시
./build/room/wildpaw-room 7001 4 30 9100
```

인자:
- `port` (기본: `7001`)
- `io_threads` (기본: `max(2, hw_concurrency)`)
- `tick_rate` (기본: `30`)
- `metrics_port` (기본: `9100`)

## 전송 프로토콜
- 스키마: `shared/protocol/fbs/wildpaw_protocol.fbs`
- Envelope(`WPAR`) 필드:
  - `seq`, `ack`, `ack_bits`, `payload(union)`

### C2S payload
- `HelloPayload`
- `ActionCommandPayload` (권장)
- `InputPayload` (legacy-compat)
- `PingPayload`

### S2C payload
- `WelcomePayload`
- `SnapshotPayload` (`kind=Base|Delta`)
- `CombatEventPayload` (사격/스킬/데미지/다운)
- `ProjectileEventPayload` (spawn/hit/despawn)
- `EventPayload`

> 현재 combat/skill 판정은 스캐폴드용 서버 authoritative 샘플 룰이며,
> `room/src/combat_rule_table.cpp`에서 탄약/재장전/쿨다운/캐스트타임/데미지 수치를 조정할 수 있습니다.

## 코드젠
```bash
./scripts/generate_protocol.sh
```

## Prometheus 지표
```bash
curl -s http://127.0.0.1:9100/metrics
```

주요 지표:
- `wildpaw_room_pending_input_queue_depth`
- `wildpaw_room_tick_overrun_total`
- `wildpaw_room_retransmit_sent_total`
- `wildpaw_room_retransmit_dropped_total`
- `wildpaw_room_reliable_inflight_packets`
- `wildpaw_room_combat_event_sent_total`
- `wildpaw_room_projectile_event_sent_total`
- `wildpaw_room_combat_event_filtered_total`
- `wildpaw_room_projectile_event_filtered_total`

## 로컬 부하 벤치
```bash
cd client/web
npm install
npx tsx ./scripts/bench-room.ts --url ws://127.0.0.1:7001 --clients 150 --duration-ms 8000 --input-interval-ms 50
```

## 참고
`wire_json.*` / `wire_binary.*`는 마이그레이션/비교용 레거시 경로입니다.
실제 메인 경로는 `wire_flatbuffers.*`입니다.
