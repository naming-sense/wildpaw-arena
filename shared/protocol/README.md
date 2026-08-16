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
- `StatusEffectEventPayload` (`Apply|Remove`, 서버 tick duration)
- `EventPayload`

`SnapshotPayload.players[]`의 `PlayerState`에는 이동/체력 외에 아래 전투 상태도 포함됩니다.
- `hero_id`, `aim_radian`
- `hp`, `shield` (`shield`는 서버 승인 보호막 잔량)
- `ammo`, `max_ammo`, `is_reloading`, `reload_remaining_ticks`
- `skill_q_cooldown_ticks`, `skill_e_cooldown_ticks`, `skill_r_cooldown_ticks`
- `casting_skill`, `cast_remaining_ticks`

`aim_radian`은 이동 여부와 관계없이 마지막으로 서버가 승인한 조준 방향입니다.
`*_ticks` 잔여값은 `WelcomePayload.server_tick_rate` 기준 서버 tick 단위입니다.

`StatusEffectEventPayload`는 `effect_id`로 Apply/Remove를 연결하며,
`duration_ticks`와 `magnitude`는 서버가 승인한 상태 계약입니다. Slow는 활성
효과 중 가장 큰 magnitude만 이동 속도에 적용하고, Stun은 이동·사격·스킬과
진행 중 캐스트를 차단합니다. Shield magnitude는 해당 효과의 현재 잔량이며
`PlayerState.shield`는 플레이어에게 남은 보호막 총량입니다.
최초 Base와 interest 재진입에서는 진행 중인 효과의 남은 duration을 Apply baseline으로 보냅니다.

`ProjectileEventPayload`의 Spawn을 받은 세션은 같은 projectile의 Hit/Despawn까지 받습니다.
일반 사격 피해는 예약된 Hit tick에 확정됩니다.

`CombatEventPayload.aim_radian`은 스킬 실행 시 서버가 승인한 조준 방향입니다.
클라이언트는 캐스트 도중 로컬 조준이 바뀌어도 이 값을 resolve 연출에 사용합니다.
