# shared/protocol

서버/클라이언트 공용 프로토콜 정의입니다.

## 구조
- `fbs/wildpaw_protocol.fbs`
  - FlatBuffers 스키마(Envelope + payload union)
- `generated/cpp/wildpaw_protocol_generated.h`
  - C++ 코드젠 결과물
- `message_types.hpp`, `packet_header.hpp`
  - 초기 실험용 헤더(레거시)

## 코드 생성
레포 루트 기준:

```bash
./scripts/generate_protocol.sh
```

(직접 실행 시)

```bash
flatc --cpp --scoped-enums -o shared/protocol/generated/cpp shared/protocol/fbs/wildpaw_protocol.fbs
flatc --ts -o client/web/src/netcode/gen shared/protocol/fbs/wildpaw_protocol.fbs
```

## FlatBuffers Envelope 핵심 필드
- `seq:uint`
- `ack:uint`
- `ack_bits:uint`
- `payload:MessagePayload (union)`

`MessagePayload`에는 현재 아래 타입이 포함됩니다.
- `HelloPayload`
- `InputPayload`
- `PingPayload`
- `WelcomePayload`
- `SnapshotPayload`
- `EventPayload`
