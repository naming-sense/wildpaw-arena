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
메타 필드:
- `seq`: 발신자가 증가시키는 패킷 시퀀스
- `ack`: 수신한 상대 패킷 중 가장 큰 seq
- `ackBits`: `ack-1 ... ack-32` 수신 비트맵

클라이언트 -> 서버:
```json
{"seq":1,"ack":0,"ackBits":0,"t":"C2S_HELLO","d":{"roomToken":"...","clientVersion":"0.2.0"}}
{"seq":2,"ack":1,"ackBits":0,"t":"C2S_INPUT","d":{"inputSeq":1,"moveX":1,"moveY":0,"fire":false,"aimRadian":0.0}}
{"seq":3,"ack":2,"ackBits":1,"t":"C2S_PING","d":{}}
```

서버 -> 클라이언트:
```json
{"seq":1,"ack":2,"ackBits":1,"t":"S2C_WELCOME","d":{"playerId":1001,"serverTickRate":30,"serverTick":0}}
{"seq":2,"ack":2,"ackBits":1,"t":"S2C_SNAPSHOT_BASE","d":{"serverTick":0,"serverTimeMs":1739530000000,"players":[...]}}
{"seq":3,"ack":3,"ackBits":3,"t":"S2C_SNAPSHOT_DELTA","d":{"serverTick":12,"serverTimeMs":1739530000400,"players":[...]}}
{"seq":4,"ack":3,"ackBits":3,"t":"S2C_EVENT","d":{"name":"pong","message":"ok"}}
```

> 현재는 JSON 기반으로 빠르게 실험 가능한 상태이며, 다음 단계에서 FlatBuffers + binary transport로 전환 예정.
