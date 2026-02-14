# Wildpaw Server Scaffold (C++20 + Asio/Beast)

## 구성
- `room/`: 실시간 authoritative 룸 서버
  - WebSocket **binary-only** C2S/S2C
  - FlatBuffers Envelope decode/encode
  - 30Hz tick + 관심영역 기반 snapshot 전송
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
./build/room/wildpaw-room         # 기본 7001 포트
./build/room/wildpaw-room 7010    # 포트 지정
```

## 전송 프로토콜
- 스키마: `shared/protocol/fbs/wildpaw_protocol.fbs`
- Envelope(`WPAR`) 필드:
  - `seq`, `ack`, `ack_bits`, `payload(union)`

### C2S payload
- `HelloPayload`
- `InputPayload`
- `PingPayload`

### S2C payload
- `WelcomePayload`
- `SnapshotPayload` (`kind=Base|Delta`)
- `EventPayload`

## 참고
현재는 FlatBuffers full-binary로 통신하며,
이전 JSON 경로(`wire_json.*`)는 마이그레이션 참고용으로 남아 있습니다.
