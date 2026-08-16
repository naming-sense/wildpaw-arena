# Wildpaw Arena 프로젝트 진행상황 분석

- 분석 시각: 2026-08-13 10:46 KST
- 후속 구현 반영: 2026-08-13 12:59 KST
- 분석 기준 커밋: `bf8934e` (`Add Lumen Village well asset preset`)
- 구현 기준: 위 커밋 이후 로컬 작업 트리
- 분석 범위: 제품 문서, 웹 클라이언트, C++ 룸 서버, Gateway, 공용 프로토콜·데이터, 자동화, 에셋, Git 이력
- 분석 방식: 문서와 실제 코드의 정적 교차 검증

이번 후속 작업으로 원격 hero/aim 계약, 히어로별 모델, 전투 잔여 상태 HUD, 투사체·상태이상·스킬 아키타입 런타임, 서버 spawn, 실제 초기 동기화 기반 룸 접속 성공 처리를 연결했다. 빌드와 패키징은 수행하지 않았으며 정적 검사 결과는 6절에 기록했다.

## 1. 종합 판단

Wildpaw Arena의 현재 단계는 **클라이언트·Gateway·룸 서버가 연결된 실행형 기술 프로토타입이자 세로 슬라이스 일부 구현 단계**다.

브라우저에서 온보딩, 로비, 큐, 레디 체크, 드래프트, 룸 접속, 실시간 이동·사격·스킬, 결과 화면까지 이어지는 구조가 코드에 존재한다. Three.js 클라이언트, C++ 권위형 룸 서버, FlatBuffers 실시간 프로토콜, 인메모리 Gateway, 3개 블록아웃 맵, 저장소 단위 CI 하네스도 갖춰져 있다.

현재 사용자가 실제로 선택할 수 있는 콘텐츠는 히어로 2종과 개발용 모드 2종이다. 3v3·5v5 모드는 UI에서 준비 중으로 제한되어 있고, 룸 서버에는 맵별 목표·점수·승패 규칙이 없다. Gateway가 시간 종료 후 임의 점수로 결과를 만들기 때문에 실제 한 경기의 결과가 권위형 룸 시뮬레이션에서 끝까지 연결되지는 않는다.

따라서 현재 상태를 다음처럼 판정한다.

| 구분 | 판정 | 의미 |
|---|---|---|
| 기술 PoC | 달성 | 브라우저, Gateway, C++ 룸 서버, 실시간 프로토콜이 각각 실행 가능한 형태로 존재한다. |
| 통합 프로토타입 | 달성 | 매치 할당 후 웹 클라이언트가 룸 endpoint와 token을 사용해 전투 런타임을 시작한다. |
| 세로 슬라이스 | 부분 달성 | 전투·맵·게임플로우 골격은 있으나 한 모드의 권위형 승패와 결과 정합성이 닫히지 않았다. |
| MVP | 미달성 | 8히어로, 3v3 실전 모드, 안정성·성능·회귀 검증 근거가 부족하다. |
| 서비스 준비 | 착수 전 | 실인증, 영속 저장, 독립 매치메이커·룸 할당, 운영 보안과 확장 체계가 남아 있다. |

진척률 백분율은 산정하지 않았다. 현재 문서에는 최신 마일스톤별 작업 분모와 통과 기록이 없고, 계획 문서의 체크박스가 실제 구현과 맞지 않아 숫자가 진행상황을 왜곡할 가능성이 크다.

## 2. 현재 실행 구조

```text
웹 클라이언트
  ├─ JSON Control WebSocket ─> Gateway
  │                              ├─ 온보딩/파티/큐/드래프트
  │                              ├─ 인메모리 매칭
  │                              └─ room endpoint + token 발급
  │
  └─ FlatBuffers Realtime WebSocket ─> C++ Room Server
                                         ├─ 30Hz 권위형 이동/전투
                                         ├─ snapshot + ack/retransmit
                                         ├─ 맵 경계/충돌/사격 LOS
                                         └─ metrics/admin
```

현재 경계에서 가장 큰 단절은 다음 두 가지다.

1. Gateway의 팀·드래프트 결과가 룸 입장 권한에 결합되지 않는다.
2. 룸의 실제 전투·목표 결과가 Gateway의 결과 처리로 전달되지 않는다.

## 3. 영역별 진행상황

### 3.1 기획·명세

상태: **범위가 넓게 정의됨, 현황 표시는 오래됨**

게임 비전, 전투, 서버, 매칭, 경제, 텔레메트리, UX/UI, 레벨, RL 대체봇까지 제품 전반의 문서가 있다. 구현팀이 다음 기능을 설계하는 데 필요한 재료는 충분하다.

현재 계획 문서의 완료 체크와 “다음 액션”은 실제 코드보다 뒤처져 있다. 예를 들어 레벨 계획서는 구현 전 체크 상태를 유지하지만 3개 맵 로더·검증기·런타임은 이미 존재한다. 반대로 8히어로와 서비스 기능은 문서 정의가 상세해도 구현 완료 근거가 없다.

근거:

- 저장소 정본과 검증 진입점: `../STATUS.md:19-107`
- 권장 전체 개발 단계: `../README.md:125-129`
- 전투 MVP 완료 조건: `../18_캐릭터_무기_전투_클라이언트_개발계획서.md:21-39`
- 레벨 클라이언트 완료 조건: `../23_레벨_블록아웃_기반_클라이언트_개발명세서_및_계획서.md:21-42`
- RL 대체봇 구현 체크리스트: `../24_매칭실패_대체봇_RL_설계_MDP_리워드_학습_시뮬레이션.md:386-394`

### 3.2 웹 클라이언트

상태: **플레이 가능한 프로토타입, 핵심 동기화 계약 연결, 콘텐츠는 부분 구현**

구현된 기반:

- Vite, React, Three.js, Zustand, TypeScript strict 구성
- RAF 렌더와 30Hz 고정 시뮬레이션 분리
- ECS 기반 입력·이동·충돌·무기·스킬·애니메이션 순서
- FlatBuffers 입력과 snapshot 처리
- 로컬 prediction/reconciliation과 원격 interpolation
- 원격 hero ID와 정지 조준 방향 동기화
- 재장전·Q/E/R 쿨다운·캐스팅 잔여 상태 디코드와 HUD
- 권위형 투사체 lifecycle과 Slow·Stun·Shield 판정·Apply/Remove
- shared 밸런스 기반 8히어로 24스킬 아키타입 ECS 런타임과 지속형 시각화
- `Welcome + Base Snapshot + profile.applied + 선택 hero 로컬 PlayerState` 완료 기반 룸 접속 성공 보고
- 초기 동기화가 8초 안에 끝나지 않을 때 소켓을 닫고 backoff 재접속하는 watchdog
- 재접속 상태, FPS·ping·packet loss·draw call 디버그 정보
- BOOT부터 RESULT까지의 화면 상태 머신
- 모바일 공격 및 Q/E/R 입력 UI
- GLB·애니메이션 검사용 Model Lab

근거:

- 클라이언트 구현 개요: `../client/web/README.md:10-33`
- 앱 시작과 실시간 소켓 시작: `../client/web/src/app/gameApp.ts:466-479`
- Gateway 상태 전이 UI: `../client/web/src/ui/flow/AppFlowLayer.tsx:720-785`
- snapshot 디코드: `../client/web/src/net/socketClient.ts:464-550`

실제 콘텐츠 범위:

- 히어로와 무기 정의는 8종이다: `../client/web/src/gameplay/hero/heroDefs.ts:11-86`, `../client/web/src/gameplay/weapon/weaponDefs.ts:12-95`
- 선택 가능한 히어로는 `coral_cat`, `bruno_bear` 2종이다: `../client/web/src/ui/store/useAppFlowStore.ts:129-145`
- 실행 가능한 모드는 `solo_test`, `1v1_dev`다.
- `3v3_normal`, `3v3_rank`, `5v5_event`는 준비 중으로 제한된다: `../client/web/src/ui/store/useAppFlowStore.ts:208-245`
- 8히어로 모두 실제 hero ID에 대응하는 개별 GLB 경로를 사용한다. 애니메이션이 없는 Lumifox·Iris는 정적 모델로 표시한다.
- 서버는 실제 hero ID를 snapshot에 보존하고, 전용 룰이 없는 히어로만 범용 `ranger`, `bruiser`, `skirmisher` 규칙으로 판정한다.

이번 후속 구현:

- `PlayerState.hero_id`, `aim_radian`을 append-only 방식으로 추가했다.
- `CombatEventPayload.aim_radian`을 append-only로 추가해 긴 캐스트도 서버가 승인한 방향으로 연출한다.
- 원격 entity가 hero 변경을 감지해 해당 GLB와 무기·스킬 구성을 교체한다.
- snapshot의 reload/cooldown/cast tick을 서버 tick rate 기준 초 단위로 표시한다.
- projectile ECS와 서버 Spawn/Hit/Despawn을 연결했다.
- Slow는 권위 이동 감속, Stun은 이동·사격·스킬 잠금, Shield는 피해 선흡수와 잔량 HUD까지 연결했다.
- 클라이언트 prediction도 권위 Slow의 최대 magnitude와 Stun 잠금을 반영한다.
- shared 밸런스의 8히어로 24스킬을 `Dash/Projectile/Zone/Channel/Buff/Shield/Rescue` ECS 런타임으로 소비하고, 위치·반경·앵커·수명을 지속형 Three.js 표현에 반영한다.
- 룸 서버가 맵 JSON의 팀·phase spawn을 선택하고 첫 로컬 snapshot에서 즉시 확정 좌표로 맞춘다.
- Gateway 성공 보고는 WebSocket open 이후 `Welcome`, Base Snapshot, `profile.applied`, 선택 hero가 반영된 로컬 상태가 모두 도착해야 실행된다.
- 재접속 중에는 로컬 prediction을 멈추고, 이전 연결의 비동기 메시지와 조준 캐시를 폐기한다.

### 3.3 게임플로우와 Gateway

상태: **전체 흐름을 재현하는 인메모리 스캐폴드**

Gateway에는 다음 흐름의 처리기가 있다.

- Boot, guest/provider login, onboarding
- party와 custom room
- queue, match found, ready check, penalty
- draft, turn validation, timeout autopick
- match assign, room connect retry, queue recovery
- simulated match end와 rematch

근거:

- 이벤트 목록과 상태: `../server/gateway/src/control_gateway_server.mjs:57-112`
- 인메모리 상태 저장소: `../server/gateway/src/control_gateway_server.mjs:137-164`
- Draft와 room token 발급: `../server/gateway/src/control_gateway_server.mjs:1600-1697`

운영 서비스와 다른 부분:

- provider token은 외부 검증 없이 문자열 hash로 계정을 만든다.
- 계정, 파티, 큐, 매치 상태는 프로세스 메모리에만 저장된다.
- 단일 `ROOM_ENDPOINT`를 사용하며 독립 room allocator가 없다.
- 재접속 창 알림은 있으나 새 연결을 기존 경기 상태에 다시 결합하는 완전한 복구 경로가 없다.
- 경기 종료는 룸 결과 대신 타이머와 임의 점수로 생성된다: `../server/gateway/src/control_gateway_server.mjs:1695-1773`

현재 Gateway는 계약 검증과 로컬 통합 개발에는 유효하다. 장기 실행, 다중 인스턴스, 실제 계정·랭크·보상 저장에는 사용할 수 없다.

### 3.4 C++ 권위형 룸 서버

상태: **기능성 전투·네트워크 프로토타입**

구현된 기반:

- C++20 + Boost.Asio/Beast binary WebSocket
- FlatBuffers Envelope와 Base/Delta snapshot
- `seq`, `ack`, `ack_bits` 기반 재전송 큐
- 고정 tick thread와 입력 worker queue
- 팀 슬롯과 룸 정원 제한
- 탄약, 재장전, 쿨다운, 캐스트타임
- 사격, 피해, knockout, projectile 이벤트
- 실제 hero ID·정지 aim snapshot과 상태이상 Apply/Remove 이벤트
- Slow 이동 감속, Stun 행동 잠금·cast 취소, Shield 피해 선흡수와 snapshot 잔량
- 맵 JSON의 팀·slot 기반 승인 spawn
- 세션당 최초 유효 hero 선택만 허용하는 서버 profile 적용
- 발사 궤적 종단 반경·LOS를 다시 확인한 뒤 Hit 또는 Despawn을 확정하는 투사체 lifecycle
- 맵 JSON 기반 경계·정적 충돌과 사격 LOS
- viewer별 enter/leave baseline을 포함한 interest filtering
- 전투 룰 JSON 핫리로드
- Prometheus와 Admin 상태·세션·위반·강제 종료·룰 리로드 API

근거:

- 서버 코드 기준 구현 목록: `../server/SERVER_SPEC.md:11-34`
- 맵 로드와 collider 구성: `../server/room/src/main.cpp:393-441`
- 브루노·코랄 전용 스킬과 범용 fallback: `../server/room/src/room_simulation.cpp:573-767`
- 룸 입장 token과 match/map 확인: `../server/room/src/main.cpp:1153-1228`

남은 핵심:

- 모드 목표, 점수, 시간, respawn, 승패 판정
- 룸 결과의 Gateway 전달
- 8히어로 전체 전용 Q/E/R과 공유 밸런스 연동
- lag compensation과 정밀 입력 replay
- 실서비스 TLS, rate limit, 운영 인증·권한
- 룸 프로세스 수명주기와 allocator 연동

`SERVER_SPEC.md`의 맵 충돌과 LOS 미구현 표기는 이번 후속 작업에서 실제 코드에 맞게 갱신했다.

### 3.5 공용 프로토콜과 밸런스 데이터

상태: **전투 표현 계약 확장, 매치 정합성과 SSoT는 미완성**

FlatBuffers에는 Hello, ActionCommand, SelectProfile, Ping, Welcome, Snapshot, CombatEvent, ProjectileEvent, StatusEffectEvent가 정의되어 있다.

현재 계약에서 부족한 정보:

- Gateway account/session identity
- Gateway가 정한 team ID와 slot의 서명된 입장 정보
- Draft에서 확정한 hero ID를 서명된 룸 입장 권한과 결합하는 정보
- 모드 목표 상태, 점수, 경기 시간, 승패와 종료 이벤트
- 재접속용 일관된 player identity

밸런스 데이터도 세 갈래로 나뉜다.

| 데이터 | 범위 | 현재 소비 경로 |
|---|---|---|
| `shared/data/hero_balance_mvp_v0.2.json` | 기획상 MVP 8히어로 | 클라이언트 메인 스킬 카탈로그·아키타입 런타임이 소비, 룸 서버는 직접 소비하지 않음 |
| `client/web/src/gameplay/hero/heroDefs.ts`, `weaponDefs.ts` | 클라이언트 8히어로 표시·기본 수치 | 메인 웹 런타임 |
| `server/room/config/combat_rules.json` | 범용 3프로필 + 브루노·코랄 | 룸 서버 전투 |

`combatDataLoader.ts`와 validator는 메인 `combatDataCatalog.ts`에서 shared 밸런스를 읽는다. 8히어로 24스킬의 canonical ID, Q/E/R slot, 아키타입 누락을 시작 시 검증한다. 룸 서버는 여전히 별도 `combat_rules.json`을 사용한다.

현재 우선 과제는 스키마보다 데이터 소유권 확정이다. hero ID, 전투 수치, 스킬 타입의 정본을 하나로 정하고 클라이언트 표시와 서버 판정이 같은 생성물을 사용해야 한다.

### 3.6 레벨과 게임 모드

상태: **3개 렌더 가능한 블록아웃, 모드 게임플레이는 미연동**

구현된 항목:

- `NJD_CR_01`, `HMY_SZ_01`, `FDD_PH_01` 맵 JSON
- 맵 로더와 모드별 validator
- primitive prefab과 AABB 충돌
- spawn safety 계산과 fallback 데이터
- Crystal Rush, Switch Zone, Payload의 목표 시각화
- minimap symbol 생성
- FOW와 장애물 차폐

근거:

- 맵 registry와 로드 시 검증: `../client/web/src/level/data/levelLoader.ts:7-60`
- 레벨 런타임: `../client/web/src/level/runtime/levelRuntime.ts:277-400`

메인 게임은 레벨의 경계, collider, FOW를 사용한다. 룸 서버는 같은 맵 JSON의 팀 spawn을 읽고 팀·slot에 맞는 첫 phase 좌표를 승인한다. 클라이언트는 최초 권위 snapshot을 받은 즉시 그 좌표로 맞춘다. `minimapSymbols`, `spawnFallbackOffsets`, `setSwitchActiveZone()`, `setPayloadProgress()`는 아직 메인 런타임에서 사용되지 않는다.

룸 서버에도 objective 상태와 모드 점수 규칙이 없다. 현재 3개 맵은 플레이 공간과 목표 표시가 준비된 상태이며, 완결된 게임 모드는 아니다.

### 3.7 테스트, 하네스, CI

상태: **진입점은 갖춰짐, 회귀 범위와 실제 E2E 증명은 부족**

구현된 진입점:

- `scripts/bootstrap.sh`: JS 의존성 설치와 선택적 프로토콜 생성
- `scripts/check.sh`: 프로토콜, 클라이언트, 레벨, Gateway 구문, 룸 서버 빌드
- `scripts/smoke.sh`: 룸과 Gateway 실행 후 capacity 및 control flow smoke
- `.github/workflows/ci.yml`: bootstrap, check, smoke 실행

현재 Vitest 자동 테스트는 4건이다.

1. snapshot 선형 보간
2. 원형 각도 aim 보간과 전투 상태 유지
3. reconciliation hard snap
4. fixed-step tick 수

근거: `../client/web/src/tests/`

현재 루트 smoke는 룸 capacity와 Gateway control smoke를 서로 분리해 실행한다. Gateway smoke는 실제 room endpoint에 접속하지 않고 `C2S_ROOM_CONNECT_RESULT: OK`를 직접 보낸다. 따라서 다음 항목은 자동 검증되지 않는다.

- Gateway token을 사용한 Room Hello
- Welcome과 Base Snapshot 수신
- Gateway 팀·slot과 Room 팀·slot 일치
- Draft hero와 Room profile 일치
- map ID 일치
- 실제 룸 결과와 Gateway 결과 일치

Gateway smoke는 결과를 출력하지만 기대값 불일치로 명시적으로 실패시키는 assertion이 부족하다: `../server/gateway/scripts/smoke_control_flow.mjs:235-270`.

클라이언트의 `tsconfig.json`은 `src`만 포함하므로 `client/web/scripts/*.ts`는 기본 `tsc --noEmit` 대상이 아니다.

### 3.8 에셋

상태: **프로토타입 리소스가 풍부함, 저장소 용량 정책 정리가 필요함**

정적 집계 기준 `client/web/public/assets`는 약 0.9GB이며 대부분을 GLB 31개가 차지한다. 동일 캐릭터의 여러 애니메이션·백업 변형이 runtime 경로에 함께 있다.

`.gitattributes`는 GLB를 Git LFS로 지정하고 `ASSET_STRATEGY.md`도 신규 heavy binary의 LFS 사용을 요구한다. 최신 커밋의 8.4MB 우물 GLB는 LFS pointer가 아닌 일반 Git blob으로 저장되어 정책과 실제가 맞지 않는다.

에셋 삭제, 대량 이동, 과거 이력 LFS 변환은 별도 승인 범위다. 단기적으로는 runtime manifest가 실제 사용하는 파일과 실험·백업 파일을 구분하고, 신규 파일부터 LFS 정책을 검증하는 CI가 필요하다.

## 4. 주요 위험과 우선순위

### P0 — 다음 세로 슬라이스를 막는 항목

#### P0-1. 팀·히어로 권위 계약 단절

Gateway는 `teamInfo`와 Draft 결과를 클라이언트에 전달한다. Room의 `HelloPayload`는 token과 client version만 포함하고, 룸 서버는 접속 순서로 팀을 다시 배정한다. 클라이언트는 `SelectProfilePayload`로 전투 프로필을 선택할 수 있다.

영향:

- Gateway 팀과 실제 전투 팀이 달라질 수 있다.
- Draft 선택과 전투 히어로가 달라질 수 있다.
- 권위형 서버가 매치 구성의 최종 권위를 갖지 못한다.

근거:

- `../server/gateway/src/control_gateway_server.mjs:1671-1689`
- `../shared/protocol/fbs/wildpaw_protocol.fbs:57-60`
- `../server/room/src/main.cpp:1233-1250`
- `../server/room/src/room_simulation.cpp:178-207`

#### P0-2. 실제 경기 결과 미연동

Gateway는 매치 타이머 종료 후 임의의 두 점수를 만들고 RP·XP·재화를 계산한다. 룸 서버는 objective·score·match end를 생성하지 않는다.

영향:

- 플레이 결과와 결과 화면이 연결되지 않는다.
- 랭크·보상·리매치 검증이 실제 전투 품질을 증명하지 못한다.

근거: `../server/gateway/src/control_gateway_server.mjs:1695-1773`

#### 해결됨. Room 접속 성공의 오탐

`GameApp.waitForInitialWorld()`가 `Welcome`, Base Snapshot, `profile.applied`, 선택 hero가 반영된 로컬 PlayerState를 모두 확인한다. `AppShell`은 이 조건이 제한 시간 안에 충족된 경우에만 Gateway에 성공을 보고한다.

실패·시간 초과 시 런타임을 정리하고 `ROOM_CONNECT_RESULT(FAIL)` 경로로 보낸다. 재접속도 새 연결의 Welcome, Base, 로컬 상태가 모두 동기화된 뒤에만 `Connected`로 복귀한다.

연결은 열렸지만 초기 동기화가 오지 않는 경우에는 8초 watchdog이 해당 소켓을 닫고 backoff 재접속을 시작한다. 재접속 중 로컬 prediction은 일시 정지한다.

#### P0-4. 개발용 룸 인증의 운영 노출

룸 서버는 `dev-room` 문자열을 항상 유효하게 처리한다. token 서명은 FNV-1a 32비트이며 기본 secret이 코드에 있다.

영향:

- 먼저 접속한 개발 token이 활성 match/map을 선점할 수 있다.
- 정원 점유와 정상 매치 mismatch를 유발할 수 있다.

근거:

- `../server/room/src/main.cpp:253-323`
- `../server/room/src/main.cpp:1181-1228`
- `../server/gateway/src/control_gateway_server.mjs:47-52`

#### 해결됨. 맵 설정과 tick 간 동시 접근 가능성

맵 bounds, collider, team spawn setter의 성공·fallback 경로를 모두 `simulationMutex_`로 보호한다.

### P1 — MVP 품질을 막는 항목

1. 클라이언트가 shared 밸런스를 소비하지만 룸 서버 룰은 별도 파일이라 hero·weapon·skill 수치 정본이 아직 분리되어 있다.
2. 선택 UI의 실제 지원 히어로는 2종이다. 8히어로 모델·24스킬 클라이언트 아키타입 런타임은 연결됐지만 나머지 6종의 전용 서버 스킬 판정은 범용 fallback이다.
3. 권위 상태이상은 Slow·Stun·Shield 3종이다. Root, DamageAmp, HealOverTime 등 기획 효과는 서버 확장이 필요하다.
4. 실제 재접속 identity 복원, 계정 영속화, 룸 allocator가 없다.
5. 자동 테스트가 핵심 전투·프로토콜·레벨·UI 회귀를 충분히 보호하지 않는다.
6. 성능 목표를 통과했다는 최신 브라우저·디바이스 측정 근거가 없다.

### P2 — 서비스 준비 항목

- OAuth/JWT 검증과 세션 보안
- DB, 분산 lock, 다중 Gateway 상태 동기화
- 독립 matchmaker와 room allocator
- 운영 환경 TLS, rate limit, 권한별 Admin
- 텔레메트리 파이프라인, Grafana/Alertmanager, 장기 부하 시험
- 랭크, 경제, 배틀패스, 상점, 라이브옵스
- RL 대체봇 학습·평가·배포 파이프라인

## 5. 권장 실행 순서

### 단계 1. 통합 신뢰성 복구

목표: Gateway가 만든 매치 구성이 Room과 클라이언트에서 동일하게 보이도록 한다.

작업:

1. room token을 `matchId`, `accountId`, `teamId`, `teamSlot`, `heroId`, `mapId`, 만료 시각에 결합한다.
2. `dev-room` 허용을 명시적 개발 모드로 제한하고 HMAC 기반 서명으로 교체한다.
3. Room은 token의 팀·slot·hero를 권위 값으로 사용한다.
4. 완료: 클라이언트는 `Welcome + Base Snapshot + profile.applied + 선택 hero 로컬 PlayerState` 이후에만 `ROOM_CONNECT_RESULT(OK)`를 보낸다.
5. 완료: map 적용과 tick의 mutex 경계를 통일했다.
6. Gateway Match Assign부터 실제 Room Welcome까지 하나의 통합 smoke로 검증한다.

완료 조건:

- 6명이 Gateway에서 받은 팀·slot·hero 그대로 Room에 입장한다.
- 만료·변조·중복 token이 거부된다.
- 룸이 꺼진 상태에서 클라이언트가 성공을 보고하지 않는다.
- 통합 smoke가 불일치 시 non-zero로 종료한다.

### 단계 2. 한 개 모드의 완결된 세로 슬라이스

권장 대상: `NJD_CR_01` + `3v3_normal` + 현재 지원 히어로 2종

작업:

1. Crystal Rush objective, score, match timer, respawn, win condition을 Room에 구현한다.
2. objective와 score snapshot/event를 FlatBuffers에 정의한다.
3. 클라이언트 HUD와 minimap을 서버 objective 상태에 연결한다.
4. Room의 최종 결과를 Gateway에 전달하고 임의 점수 생성을 제거한다.
5. 완료: 서버 쿨다운·캐스팅·projectile·status effect event를 클라이언트 표현에 연결했다.
6. 연결 중단·복구·결과·리매치까지 실제 경기로 검증한다.

완료 조건:

- 3v3 한 판이 룸의 승패 조건으로 종료된다.
- 모든 참가자의 점수와 결과가 일치한다.
- 결과 화면의 RP·XP 입력이 실제 Room 결과를 참조한다.
- 20판 자동 반복에서 상태 불일치와 프로세스 오류가 없다.

### 단계 3. MVP 콘텐츠 확장

작업:

1. `shared/data`를 hero·weapon·skill 정본으로 확정하고 생성 파이프라인을 만든다.
2. 남은 6히어로의 선택 UI, 전용 Q/E/R 서버 판정, 애니메이션·HUD QA를 완료한다.
3. Switch Zone과 Payload Howl의 서버 목표 규칙을 추가한다.
4. 3v3 랭크 규칙과 실제 MMR 저장을 연결한다.
5. 전투·레벨·프로토콜 단위 테스트와 브라우저 E2E를 확장한다.

완료 조건:

- 8히어로의 선택·표현·서버 판정 데이터가 일치한다.
- 3개 맵과 목표 모드가 권위형 서버 규칙으로 종료된다.
- 기획 문서의 전투·클라이언트 MVP 인수 조건을 자동·수동 QA 기록으로 충족한다.

### 단계 4. 서비스 기반

작업:

- 실인증과 영속 저장
- 재접속 세션 복구
- matchmaker와 room allocator 분리
- 다중 인스턴스 상태 동기화
- TLS, rate limit, 운영 Admin 권한
- 텔레메트리, 경보, 장기 부하와 장애 시험

경제·라이브옵스·RL 대체봇은 단계 2의 실제 경기 데이터 경로가 안정된 뒤 연결하는 편이 안전하다.

## 6. 검증 현황

이번 분석과 후속 구현에서는 프로젝트 규칙에 따라 빌드, 패키징, Clean 작업을 수행하지 않았다.

정적 확인 결과:

| 확인 항목 | 결과 | 비고 |
|---|---|---|
| Gateway 서버·smoke JS 구문 | 통과 | `node --check` |
| root/client shell script 구문 | 통과 | `bash -n` |
| 공용 밸런스·룰·3개 맵 JSON parse | 통과 | JSON 구문 확인 |
| TypeScript 전체 type-check | 통과 | `tsc --noEmit` |
| 변경 C++ translation unit syntax-only | 통과 | C++20, `-Wall -Wextra -Wpedantic -Werror`; `main.cpp`, `room_simulation.cpp`, `snapshot_builder.cpp`, `wire_flatbuffers.cpp` |
| protocol codegen sync | 통과 | 공식 `flatc 2.0.8`로 C++·TypeScript 생성물 재생성 |
| 변경 단위 테스트 | 통과 | 기존 Vitest 3개 파일, 4개 테스트 |
| 빌드·level validator·통합 smoke | 미실행 | 프로젝트 빌드 규칙에 따라 사용자 실행 대상으로 남김 |

정적 검사는 통과했다. 빌드와 실제 브라우저·서버 통합 동작은 사용자 검증 대상으로 남겼다.

현재 자동화 구성 자체는 다음 파일에 존재한다.

- `../scripts/check.sh:44-70`
- `../scripts/smoke.sh:116-163`
- `../.github/workflows/ci.yml:29-42`

현재 HEAD에서 CI가 성공했다는 실행 결과는 이번 분석에서 확인하지 않았다.

## 7. Git 활동과 문서 신선도

영역별 마지막 기능 변경 기록:

| 영역 | 마지막 기록 |
|---|---|
| Room server | 2026-02-23, `dd98b3f` |
| Gateway | 2026-02-23, `7a02f07` |
| Client app/UI/gameplay/level | 2026-02-23 전후 |
| Shared protocol | 2026-02-20, `b06453d` |
| Root harness/CI | 2026-04-06, `94553ca` |
| Model Lab/에셋 | 2026-05-15, `bf8934e` |

최근 Git 이력은 런타임 기능보다 문서, 하네스, 에셋 정리에 집중되어 있다. 런타임 핵심 영역은 2026년 2월 이후 기능 변경 기록이 거의 없다.

주요 문서 불일치:

1. `STATUS.md`는 bootstrap/check/smoke/CI를 목표 상태처럼 적지만 실제 파일은 이미 존재한다.
2. `server/SERVER_SPEC.md`의 맵 충돌·LOS 미구현 표기는 이번 후속 작업에서 수정했다.
3. `client/web/README.md`의 환경변수는 `VITE_GATEWAY_WS_URL`이지만 활성 UI 코드는 `VITE_CONTROL_WS_URL`을 사용한다.
4. 클라이언트 README의 room socket 초기 동기화 설명은 이번 후속 작업에서 실제 완료 조건에 맞췄다.
5. README의 `mock ws room` 표현과 달리 실행 스크립트는 C++ room binary를 요구한다.
6. 레벨 계획서의 미완료 체크와 실제 3개 맵 런타임 구현이 맞지 않는다.
7. 신규 GLB의 LFS 정책과 최신 에셋 커밋의 저장 방식이 맞지 않는다.

현재 진행상황을 계속 관리하려면 `STATUS.md`에 영역별 `구현됨 / 부분 구현 / 검증됨 / 다음 게이트` 표를 두고 기능 변경과 함께 갱신하는 방식이 적합하다.

## 8. 최종 결론

Wildpaw Arena는 문서 저장소 단계를 지나 실행형 통합 프로토타입까지 진척되었다. 클라이언트, 제어 채널, 권위형 룸 서버, 3개 맵, CI 하네스라는 중요한 기반이 이미 있다.

현재 가장 가치 있는 다음 목표는 콘텐츠 수를 늘리는 작업보다 **실제 3v3 한 판의 권위 상태를 처음부터 결과까지 닫는 작업**이다. 실제 룸 접속 확인은 완료됐다. 팀·히어로 입장 권한, 모드 목표·승패, 룸 결과 전달, 진짜 E2E smoke를 이어서 완성하면 현재 프로토타입은 검증 가능한 세로 슬라이스로 전환된다.

그 이후에 8히어로와 3개 모드로 확장하면 클라이언트·서버·데이터가 같은 계약을 사용하게 되고, MVP 진척을 객관적인 인수 조건으로 관리할 수 있다.
