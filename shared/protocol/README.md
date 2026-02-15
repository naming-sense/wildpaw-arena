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
- `InputPayload` (legacy-compat)
- `ActionCommandPayload` (권장 C2S 입력)
- `SelectProfilePayload` (프로필/캐릭터 선택)
- `PingPayload`
- `WelcomePayload`
- `SnapshotPayload`
- `CombatEventPayload`
- `ProjectileEventPayload`
- `EventPayload`

`SnapshotPayload.players[]`의 `PlayerState`에는 이동/체력 외에 아래 전투 상태도 포함됩니다.
- `ammo`, `max_ammo`, `is_reloading`, `reload_remaining_ticks`
- `skill_q_cooldown_ticks`, `skill_e_cooldown_ticks`, `skill_r_cooldown_ticks`
- `casting_skill`, `cast_remaining_ticks`
