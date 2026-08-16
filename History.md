# History

## 2026-08-13 12:59:10 KST

- 클라이언트 prediction이 서버에서 받은 Slow의 최대 magnitude와 Stun 잠금을 동일하게 적용하도록 입력·사격·스킬 경로를 보완했다.
- `SkillRuntimeRenderSystem`을 추가해 승인된 `Dash`, `Projectile`, `Zone`, `Channel`, `Buff`, `Shield`, `Rescue` 런타임의 위치·반경·앵커·수명을 지속형 Three.js 표현으로 소비했다.
- 스킬 표현은 자연 만료와 중지, 재접속, 플레이어 제거, hero 교체에서 geometry·material을 해제한다.
- 프로젝트 상태 보고서와 클라이언트·서버 문서를 최종 구현과 룸 접속 성공 조건에 맞춰 갱신했다.
- TypeScript `tsc --noEmit`과 전체 `git diff --check`를 통과했다. 빌드·패키징·Clean은 수행하지 않았다.

## 2026-08-13 12:51:14 KST

- `PlayerState.shield`를 append-only FlatBuffers 필드로 추가하고 공식 `flatc 2.0.8`로 C++·TypeScript 생성물을 동기화했다.
- Slow의 최대 magnitude 이동 감속, Stun의 이동·공격·스킬 차단과 캐스트 취소, Shield의 선흡수·잔량 갱신·소진 즉시 Remove를 룸 서버 authoritative 판정에 연결했다.
- 보호막 잔량을 snapshot delta, 웹 소켓 디코드, 클라이언트 Health와 HUD까지 전달했다.
- shared 밸런스 데이터를 메인 클라이언트 카탈로그로 연결하고 8히어로 24스킬을 7종 아키타입 ECS 런타임으로 소비하도록 구현했다.
- 룸 접속 성공 조건을 `Welcome + Base Snapshot + profile.applied + 선택 hero 로컬 PlayerState`로 강화했다.
- C++ 변경 번역 단위의 C++20 `-Wall -Wextra -Wpedantic -Werror -fsyntax-only`와 TypeScript type-check, `git diff --check`를 통과했다.

## 2026-08-13 12:32:09 KST

- `PlayerState`에 실제 hero ID와 정지 조준각을, `CombatEventPayload`에 서버 승인 스킬 조준각을 append-only로 추가하고 FlatBuffers C++·TypeScript 생성물을 동기화했다.
- 룸 서버가 맵 JSON의 팀·phase·slot spawn을 승인 좌표로 사용하도록 연결했다.
- 원격 플레이어별 GLB 선택과 안전한 비동기 교체·자원 해제, 서버 reload·Q/E/R cooldown·cast HUD 표시를 구현했다.
- 투사체 Spawn/Hit/Despawn, 상태이상 Apply/Remove baseline, 스킬 아키타입 cue를 클라이언트 ECS 메인 런타임과 서버 이벤트에 연결했다.
- 투사체 피해를 terminal tick에 확정하고 종단 반경·LOS를 재검증하며, Spawn 수신 세션에 Hit/Despawn lifecycle이 끝까지 전달되도록 보완했다.
- 유효 hero profile 선택을 세션당 1회로 제한하고 profile 교체 시 대기 cast를 취소했다.
- 룸 접속 성공 조건을 `Welcome + Base Snapshot + 로컬 PlayerState`로 변경하고, 8초 초기 동기화 watchdog·세대별 stale 메시지 차단·재접속 중 prediction 정지를 추가했다.
- `docs/PROJECT_STATUS_ANALYSIS_2026-08-13.md`와 클라이언트·서버·공용 프로토콜 문서를 최신 구현 상태로 갱신했다.
- TypeScript 전체 type-check, FlatBuffers codegen 재현, C++ 변경 번역 단위의 C++20 `-Wall -Wextra -Wpedantic -Werror -fsyntax-only`, shell·Gateway JS·JSON 구문, `git diff --check`를 통과했다.
- 프로젝트 지침에 따라 빌드, 패키징, Clean, 런타임·통합 테스트는 수행하지 않았다.

## 2026-08-13 10:46:50 KST

- `docs/PROJECT_STATUS_ANALYSIS_2026-08-13.md`를 생성했다.
- 제품 문서와 클라이언트, C++ 룸 서버, Gateway, 프로토콜·공용 데이터, 자동화, 에셋, Git 이력을 교차 분석했다.
- 현재 단계를 실행형 기술 프로토타입·부분 세로 슬라이스로 판정하고 구현 범위, 핵심 위험, 단계별 완료 조건을 정리했다.
- Gateway·shell·JSON 정적 구문 검사를 수행했다. 로컬 의존성이 없는 TypeScript, C++, protocol codegen과 빌드·통합 테스트는 미확인 상태로 기록했다.
