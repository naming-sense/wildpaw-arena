# Wildpaw Server Scaffold (C++20 + Asio/Beast)

- 구현 스펙(실코드 기준): `SERVER_SPEC.md`
- 관리자 페이지 요구사항/범위: `ADMIN_DASHBOARD_SPEC.md`

## 용어 주의 (헷갈림 방지)
- `room` = 한 매치가 실행되는 **룸 인스턴스**
- `wildpaw-room` 프로세스 1개 = 룸 인스턴스 1개 (현재 구현)
- 단, **서버 머신 1대 = 룸 1개**는 아님 (한 머신에서 프로세스 여러 개 실행 가능)
- `rooms`(룸 개수)와 `capacity`(룸 정원, 예: 3:3=6명/5:5=10명)는 별개 개념

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
./build/room/wildpaw-room [port] [io_threads] [tick_rate] [metrics_port] [rules_json_path]

# 예시
./build/room/wildpaw-room 7001 4 30 9100 room/config/combat_rules.json
```

인자:
- `port` (기본: `7001`)
- `io_threads` (기본: `max(2, hw_concurrency)`)
- `tick_rate` (기본: `30`)
- `metrics_port` (기본: `9100`)
- `rules_json_path` (기본: `room/config/combat_rules.json`)

## 전송 프로토콜
- 스키마: `shared/protocol/fbs/wildpaw_protocol.fbs`
- Envelope(`WPAR`) 필드:
  - `seq`, `ack`, `ack_bits`, `payload(union)`

### C2S payload
- `HelloPayload`
- `ActionCommandPayload` (권장)
- `SelectProfilePayload` (프로필/캐릭터 선택)
- `InputPayload` (legacy-compat)
- `PingPayload`

### S2C payload
- `WelcomePayload`
- `SnapshotPayload` (`kind=Base|Delta`)
- `CombatEventPayload` (사격/스킬/데미지/다운)
- `ProjectileEventPayload` (spawn/hit/despawn)
- `EventPayload`

> 현재 combat/skill 판정은 스캐폴드용 서버 authoritative 샘플 룰이며,
> 기본값은 `room/src/combat_rule_table.cpp`, 런타임 오버라이드는
> `room/config/combat_rules.json`(또는 실행 인자 `rules_json_path`)으로 적용됩니다.
> 현재 스캐폴드에서는 접속 순서에 따라 프로필(`ranger/bruiser/skirmisher`)을 라운드로빈 배정합니다.
> 클라이언트는 `SelectProfilePayload`로 세션 중 프로필 변경을 요청할 수 있으며,
> 서버는 `profile.applied` / `profile.invalid` 이벤트를 반환합니다.
> 룰 JSON 파일 수정 시 서버가 주기적으로 변경을 감지해 핫리로드합니다.

## 코드젠
```bash
./scripts/generate_protocol.sh
```

## Prometheus 지표
```bash
curl -s http://127.0.0.1:9100/metrics
```

## 관리자 페이지 (Admin)
기본 URL: `http://127.0.0.1:<metrics_port>/admin/`

권장(토큰 보호):
```bash
WILDPAW_ADMIN_TOKEN="your-secret-token" \
  ./build/room/wildpaw-room 7001 4 30 9100 room/config/combat_rules.json
```

Admin API 예시:
```bash
# 상태
curl -s -H 'x-admin-token: your-secret-token' http://127.0.0.1:9100/admin/api/status

# 세션 목록(동접/IP/이상 카운터)
curl -s -H 'x-admin-token: your-secret-token' http://127.0.0.1:9100/admin/api/sessions

# 비정상 패킷/운영 이벤트 로그
curl -s -H 'x-admin-token: your-secret-token' http://127.0.0.1:9100/admin/api/violations

# 강제 연결 종료
curl -s -X POST -H 'x-admin-token: your-secret-token' \
  http://127.0.0.1:9100/admin/api/sessions/1001/disconnect

# 룰 수동 리로드
curl -s -X POST -H 'x-admin-token: your-secret-token' \
  http://127.0.0.1:9100/admin/api/rules/reload
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
- `wildpaw_room_rule_reload_success_total`
- `wildpaw_room_rule_reload_failure_total`

## 로컬 부하 벤치
```bash
cd client/web
npm install
npx tsx ./scripts/bench-room.ts --url ws://127.0.0.1:7001 --clients 150 --duration-ms 8000 --input-interval-ms 50
```

## 참고
`wire_json.*` / `wire_binary.*`는 마이그레이션/비교용 레거시 경로입니다.
실제 메인 경로는 `wire_flatbuffers.*`입니다.
