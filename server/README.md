# Wildpaw Server Scaffold (C++20 + Asio/Beast)

## 구성
- `room/`: 실시간 authoritative 룸 서버 (WebSocket 수신 + 입력 처리 + delta snapshot 전송)
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

## 현재 프로토콜 (JSON envelope, WebSocket text)
클라이언트 -> 서버:
```json
{"t":"C2S_HELLO","d":{"roomToken":"...","clientVersion":"0.1.0"}}
{"t":"C2S_INPUT","d":{"inputSeq":1,"moveX":1,"moveY":0,"fire":false,"aimRadian":0.0}}
{"t":"C2S_PING","d":{}}
```

서버 -> 클라이언트:
```json
{"t":"S2C_WELCOME","d":{"playerId":1001,"serverTickRate":30,"serverTick":0}}
{"t":"S2C_SNAPSHOT_BASE","d":{"serverTick":0,"serverTimeMs":1739530000000,"players":[...]}}
{"t":"S2C_SNAPSHOT_DELTA","d":{"serverTick":12,"serverTimeMs":1739530000400,"players":[...]}}
{"t":"S2C_EVENT","d":{"name":"pong","message":"ok"}}
```

> 추후 단계에서 FlatBuffers + binary transport로 교체 예정.
