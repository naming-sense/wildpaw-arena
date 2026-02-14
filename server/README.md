# Wildpaw Server Scaffold (C++20 + Asio/Beast)

## 구성
- `room/`: 실시간 authoritative 룸 서버
  - C2S JSON 처리 (`HELLO/INPUT/PING`)
  - 30Hz tick
  - S2C base snapshot(JSON) + delta snapshot(binary)
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

## 전송 포맷

### 1) JSON envelope (WebSocket text)
- 사용: `C2S_*`, `S2C_WELCOME`, `S2C_SNAPSHOT_BASE`, `S2C_EVENT`
- 공통 메타:
  - `seq`: 발신 시퀀스
  - `ack`: 수신한 상대의 최신 seq
  - `ackBits`: `ack-1 ... ack-32` 수신 비트맵

예시 (C2S):
```json
{"seq":1,"ack":0,"ackBits":0,"t":"C2S_HELLO","d":{"roomToken":"...","clientVersion":"0.3.0"}}
{"seq":2,"ack":1,"ackBits":0,"t":"C2S_INPUT","d":{"inputSeq":1,"moveX":1,"moveY":0,"fire":false,"aimRadian":0.0}}
```

### 2) Binary delta frame (WebSocket binary)
- 사용: `S2C_SNAPSHOT_DELTA`
- 헤더(36 bytes, little-endian):
  - `u32 magic` = `0x57445031` ("WDP1")
  - `u16 version` = `1`
  - `u16 messageType` = `1` (SnapshotDelta)
  - `u32 seq`
  - `u32 ack`
  - `u32 ackBits`
  - `u32 serverTick`
  - `u64 serverTimeMs`
  - `u16 playerCount`
  - `u16 reserved`
- 플레이어 레코드(28 bytes):
  - `u32 playerId`
  - `f32 posX, posY`
  - `f32 velX, velY`
  - `u16 hp`
  - `u8 alive`
  - `u8 reserved`
  - `u32 lastProcessedInputSeq`

> 현재는 **하이브리드(JSON + binary delta)** 단계이며, 이후 FlatBuffers full-binary로 확장 예정.
