# Client/Server Implementation History (2026-02)

이 문서는 `client/web` 기준 최근 구현 히스토리를 압축 정리한 로그입니다.

## 1) 베이스 아키텍처 착수

- Vite + React + TypeScript(strict) + Three.js + Zustand 구성
- Render loop / Fixed-step simulation 분리
- ECS 골격 추가
  - Component: Transform/Velocity/Health/Team/Weapon/SkillSet/StatusEffect/RenderProxy
  - System: Input → Movement → Collision → WeaponFire → Projectile → Skill → BuffDebuff → Animation
- Netcode 착수
  - input command(seq/clientTime) + local prediction + reconciliation
  - snapshot interpolation buffer + short extrapolation

## 2) 플레이어/애니메이션 자산 통합

- Hero GLB manifest 경로화 및 로컬/원격 엔티티 공통 로딩
- Mixamo 기반 Idle/Walk/Run 애니메이션 액션 바인딩
- 속도 기반 Idle/Run cross-fade 적용
- 모델 리소스 dispose 루틴 정리

## 3) Model Lab 전용 QA 페이지 도입

- `/model-lab.html` 추가 (게임 루프와 분리)
- GLB 로딩/클립 전환/타임라인 스크럽/스켈레톤·와이어프레임·바운드 확인
- origin/pivot 디버깅용 overlay 확장

## 4) 모델 원점/피벗 문제 해결 과정

- 허리 기준 원점 문제를 발 기준으로 전환
- 최종 pivot 정책
  - X/Z: 양발(LeftFoot/RightFoot) midpoint
  - Y: foot/toe 중 minimum (ground)
- bone name exact-match 이슈 대응: fuzzy 매칭(`leftfoot/rightfoot/toebase/toeend`)
- 텍스처 미적용 문제 해결
  - source textured GLB material 이식
  - 최종 배포 GLB에 textures/images 포함 확인

## 5) 네트워크 체감 품질 개선

- 30Hz 시뮬레이션 유지 + 렌더 프레임 보간 분리
- 원격 플레이어 velocity를 snapshot에서 갱신해 이동 애니메이션 정상화
- 로컬 이동 떨림 완화
  - 카메라 추적 기준을 transform → renderProxy 보간 위치로 전환
  - reconciliation micro-correction deadzone 적용
- 디바이스 간 체감 지연 완화
  - interpolation delay 튜닝
  - serverTime offset 추정/스무딩 후 remote sampling 시각 보정

## 6) 유령 클라이언트(ghost) 대응

서버/클라이언트 양쪽에서 정리 로직 보강:

- 서버(`scripts/mock-room-server.mjs`)
  - `clientId` 지원
  - 동일 clientId 재접속 시 이전 세션 교체
  - stale timeout 기반 세션 정리
- 클라이언트(`src/app/gameApp.ts`)
  - 스냅샷에 없는 remote entity 즉시 제거
  - scene object + animation/resource + ECS component 동시 정리

## 7) 운영/개발 도구 정리

- `scripts/run_services_detached.sh`
  - web(4173) + ws(8080) detached supervisor
  - start/stop/restart/status/logs 제공
- `scripts/mock-room-server.mjs`
  - 30Hz mock room server
  - C2S_HELLO/C2S_INPUT/C2S_PING 처리
  - S2C_WELCOME/S2C_PONG/S2C_SNAPSHOT_DELTA 브로드캐스트

## 8) 현재 확인된 기본 실행 플로우

```bash
cd client/web
npm install
npm run build
npm run test
./scripts/run_services_detached.sh restart
```

- Game: `http://<host>:4173/`
- Model Lab: `http://<host>:4173/model-lab.html`
- WS mock room: `ws://<host>:8080`

## 9) 기획서 기반 전투 루프 + HUD/입력 확장

- Hero/Weapon 밸런스 연동
  - 서버가 `shared/data/hero_balance_mvp_v0.2.json`를 읽어 8히어로 프로필 적용
  - 히어로별 HP/이속/사거리/데미지/탄창/재장전/치명/감쇠 반영
- 서버 authoritative 발사/피격
  - 조준/전방/측면 폭 기반 타겟 선택
  - 거리 감쇠 + 패시브 + 크리티컬 포함 데미지 계산
  - 사망/리스폰/재장전 루프 동작
- 네트워크 스냅샷 확장
  - `heroId/heroName/maxHp/ammo/maxAmmo/reloading` 동기화
- 클라이언트 HUD 확장
  - HERO/HP/MAXHP/AMMO/RELOAD 상태 표시
  - 로컬 선택 hero를 `?hero=` + localStorage + HELLO payload로 전송

## 10) 모바일 공격 UI 및 탭 입력 안정화

- 모바일 전용 `공격` 버튼 UI(`AppShell`, `styles.css`) 추가
- `keyboardMouse` 입력 파이프라인에서 fire 버튼 포인터 캡처 지원
- 짧은 탭 누락 방지
  - `touchFireTapQueued`로 최소 1 simulation tick 발사 보장

## 11) 탄환/피격 VFX 고도화

- 초기 흰색 트레일/임팩트에서 시작해, 이동형 projectile 트레일로 진화
  - 각 샷이 독립 수명 주기로 이동/소멸(버튼 hold와 생명주기 분리)
- 트레일 비주얼
  - core + glow 이중 실린더(additive), 짧고 굵은 트레일
  - 팀 컬러 분리(cyan/amber)
- 머즐 플래시 추가
  - 발사 순간 cone + glow 짧은 burst
- 명중 피드백
  - 공격자: 히트마커 + 데미지 숫자(critical 강조)
  - 피격자: incoming 데미지 숫자 + red overlay + impact ring burst
- 서버 이벤트 채널 확장
  - `S2C_EVENT`(`hit-confirm`, `damage-taken`)로 피드백 동기화

## 12) 바라보는 방향/조작감 동기화 수정

- 2클라 테스트에서 로컬/원격 facing 불일치 수정
  - command aim + authoritative rot 보정 연결
- 조작감 요구사항 반영
  - 이동 입력 중에는 "누른 방향"을 바라보도록 복원(터치/WASD)
  - 입력 해제 시 마지막 바라보는 방향 유지(sticky facing)

## 13) 게임플로우 UX/UI 실구현 1차 (BOOT~RESULT)

- 신규 상태 스토어 도입
  - `src/ui/store/useAppFlowStore.ts`
  - AppFlowState(BOOT/AUTH/ONBOARDING/LOBBY/PARTY/QUEUEING/READY_CHECK/DRAFT/MATCH_LOADING/IN_MATCH/RESULT/RECONNECTING) + 화면별 상태/이벤트 액션 정의
- 신규 화면 레이어 도입
  - `src/ui/flow/AppFlowLayer.tsx`
  - 화면별 컴포넌트(부트/인증/온보딩/로비/큐/수락/드래프트/로딩/결과/재접속) + 런타임 타이머(큐 tick, ready check countdown, draft timeout)
- AppShell 구조 개편
  - 초기 진입을 전투 직행에서 상태머신 기반 진입으로 전환
  - `MATCH_LOADING` 시점에만 `bootstrap()`로 실제 GameApp 생성/연결
  - `RESULT/LOBBY` 등 전투 외 상태로 전환하면 GameApp 정리(stop)
- Hero 선택 연동
  - 로비/드래프트에서 선택한 heroId를 GameApp 생성 옵션으로 전달
  - `bootstrap`/`GameAppOptions`/`resolvePreferredHeroId` 확장으로 runtime hero 선택 반영
- UI 스타일 확장
  - TopBar/BottomNav/모드카드/히어로그리드/드래프트/모달/토스트/로딩바/반응형(1366, 820) 규칙 추가
- 운영/검증
  - `npm run build` ✅
  - `npm run test` ✅
  - detached 재시작(web 4173 / ws 8080) ✅

## 14) Gateway Control Channel 실연동 (20 계약서 기반)

- 클라이언트 control transport 추가
  - `src/net/controlGatewayClient.ts`
  - control WS(기본 `ws://<host>:7200`) 연결/재연결/Envelope 송수신
- AppFlow store를 이벤트 기반으로 재구성
  - `src/ui/store/useAppFlowStore.ts`
  - `bindGatewayTransport` + `applyGatewayEnvelope` 추가
  - 서버 이벤트(`S2C_BOOT_ACK`, `S2C_AUTH_OK`, `S2C_QUEUE_STATUS`, `S2C_MATCH_FOUND`, `S2C_DRAFT_*`, `S2C_MATCH_ASSIGN`, `S2C_MATCH_ENDED`, `S2C_REMATCH_*`, `S2C_ERROR`)를 상태 전이에 직접 반영
  - UI 액션이 `C2S_*` 요청을 실제 전송(`BOOT_READY`, `AUTH`, `ONBOARDING_COMPLETE`, `QUEUE_JOIN/CANCEL`, `MATCH_ACCEPT`, `DRAFT_ACTION`, `ROOM_CONNECT_RESULT`, `REMATCH_VOTE`)
- AppFlow layer 런타임 변경
  - `src/ui/flow/AppFlowLayer.tsx`
  - 부트 자동요청/핑 heartbeat/ready-check countdown/draft countdown을 서버 이벤트와 결합
  - TopBar에 GW 연결 상태 배지 추가
- AppShell 로딩/전투 시작 경계 변경
  - `src/ui/common/AppShell.tsx`
  - `S2C_MATCH_ASSIGN`의 `room.endpoint`/`roomToken`으로 실제 room 접속
  - 접속 성공 시 `C2S_ROOM_CONNECT_RESULT(OK)` 보고, 실패 시 `FAIL` 보고(재할당/복구 흐름 연결)
- runtime 옵션 확장
  - `src/app/bootstrap.ts`, `src/app/gameApp.ts`
  - `roomToken` 전달/사용 지원
- 운영 스크립트 확장
  - `scripts/run_services_detached.sh`
  - web/ws와 함께 gateway(7200) 시작/중지/상태/로그 통합
  - gateway 시작 시 `ROOM_ENDPOINT=ws://127.0.0.1:8080` 자동 주입
- 검증
  - client: `npm run build`, `npm run test` 통과
  - gateway: `server/gateway npm run smoke` 통과(`matchAssignCount=6`, `errors=[]`)
  - detached 상태: web/ws/gateway 3서비스 정상 기동 확인

## 15) 온보딩/인증 UX 보완 (피드백 반영)

- 소셜 로그인 버튼 처리
  - `Google/Apple 로그인`을 비활성화하고 `준비중` 텍스트 명시
  - 인증 화면에 현재 지원 범위(게스트 로그인) 안내 문구 추가
  - store `requestAuthProvider`도 실제 전송 대신 준비중 안내 토스트로 안전 처리
- 약관/개인정보 확인 경로 추가
  - 온보딩 체크박스 아래에 `약관 보기`, `개인정보 처리방침 보기` 링크 추가
  - 정적 페이지 추가:
    - `public/legal/terms.html`
    - `public/legal/privacy.html`
- 스타터 히어로 선택 정책 단순화
  - 다중 선택 -> 단일 선택(1명)으로 변경
  - `onboardingStarterHeroIds[]` -> `onboardingStarterHeroId`로 상태 모델 개편
  - 온보딩 제출 시 서버 payload는 단일 선택을 배열 1개(`starterHeroIds: [id]`)로 전송
  - UI 문구를 "초반 기본 히어로 1명 설정"으로 명확화

## 16) 법률 페이지 복귀 시 온보딩 유지 개선

- 문제: 약관/개인정보 페이지에서 "게임으로 돌아가기" 클릭 시 앱이 초기 AUTH 화면으로 보였음.
- 원인: 법률 페이지 이동이 SPA 상태를 끊어 메모리 상태가 초기화됨.
- 개선:
  - 온보딩 draft를 `sessionStorage`에 저장/복원(`nickname/terms/starterHero/resume`)
  - AUTH 상태에서 draft resume 플래그가 있으면 자동 `C2S_AUTH_GUEST` 재요청 후 ONBOARDING 복귀
  - 법률 링크를 새 탭이 아닌 동일 탭 이동으로 변경
  - 법률 페이지 "게임으로 돌아가기"는 `history.back()` 우선 사용(히스토리 없을 때만 `/`)
- 효과:
  - 법률 페이지 왕복 후 다시 온보딩으로 자연스럽게 복귀
  - 이미 입력한 온보딩 값도 유지 가능

## 17) 인게임 조명 밝기 상향 + 명암 편차 완화

- 사용자 피드백: 인게임 화면이 전반적으로 어둡고, 위치에 따라 밝기 차이가 크게 느껴짐.
- 조명/렌더 튜닝:
  - `src/render/lights.ts`
    - Hemisphere 강도 상향(0.5 -> 0.85)
    - AmbientLight 추가(0.2)로 암부 리프트
    - Key light 강도 상향(1.0 -> 1.18)
    - Fill/Rim light 보강으로 측면/후면 암부 완화
    - directional shadow camera 범위 확장 + bias/normalBias 조정
  - `src/render/renderer.ts`
    - `outputColorSpace = SRGBColorSpace` 명시
    - `toneMappingExposure` 상향(1.0 -> 1.2)
  - `src/render/sceneRoot.ts`
    - 배경/안개 색상 소폭 상향
    - fog 거리 조정(18~72 -> 26~96)으로 원거리 암전 완화
    - 지면 색상 소폭 상향
- 기대효과:
  - 모바일 화면에서도 전체 밝기와 가독성 개선
  - 특정 위치/방향에서 발생하던 과한 명암 대비 완화

## 18) 레벨 블록아웃 기반 클라이언트 구현(23번 문서 반영)

- 신규 레벨 모듈 추가 (`src/level/**`)
  - data
    - `levelSchema.ts`: 맵/오브젝트/프리팹/튜닝 타입 정의
    - `levelLoader.ts`: 3개 맵 로드 + validation 게이트
    - `levelValidator.ts`: 공통 + 맵별 규칙 검증
      - 공통: prefab unique, bounds, spawn safety, lane width
      - NJD: CORE (0,0,0), 스폰-코어 도달시간 편차 체크
      - HMY: zone 반경 4.5, A45/gap10/B45 로테이션 체크
      - FDD: payload path node 순서, CP1/CP2 좌표 체크
    - `maps/*.json`: `NJD_CR_01`, `HMY_SZ_01`, `FDD_PH_01` 블록아웃 데이터
  - prefab
    - `prefabCatalog.ts` / `prefabTypes.ts` / `prefabFactory.ts`
    - 블록아웃 프리팹을 렌더 메쉬 + AABB collider로 변환
  - runtime
    - `levelRuntime.ts`: 레벨 로딩/레이어 구성/static collider/objective view/debug layer 관리
    - `levelCollision.ts`: collider 유틸 + 2D segment 교차
    - `spawnSafetyCheck.ts`: 스폰 안전 반경/직선 LoS 점검 + fallback offset
    - `lineOfSightDebug.ts`, `levelNavOverlay.ts`: LoS/레인 디버그 시각화
  - modes
    - `crystalRushView.ts`, `switchZoneView.ts`, `payloadView.ts`
  - minimap
    - `minimapProjector.ts`, `minimapLayers.ts`
- 게임 런타임 연동
  - `src/app/gameApp.ts`
    - `LevelRuntime` 생성/업데이트/해제 연결
    - match assign의 `mapId`를 받아 맵 로드(쿼리 `?map=` fallback)
    - 시뮬레이션 context에 `staticColliders`, 맵 bounds 전달
  - `src/ecs/world.ts`, `src/ecs/systems/CollisionSystem.ts`
    - world bounds를 axis 단위로 확장(minX/maxX/minZ/maxZ)
    - static collider 기반 이동 충돌 보정 추가
  - `src/app/bootstrap.ts`, `src/ui/common/AppShell.tsx`
    - `mapId` 전달 경로 확장
- 운영 스크립트
  - `scripts/level-validate.ts` + `npm run level:validate` 추가
- FDD 배치값 튜닝
  - `FDD_PH_01`의 `C_BUSH_02` 좌표를 `(12,12)` -> `(15,13)`으로 조정
  - 이유: `DEF_SPAWN_P1`와 안전 반경(8m) 위반 해소
- 검증
  - `npm run level:validate` ✅ (NJD/HMY/FDD 모두 통과)
  - `npm run build` ✅
  - `npm run test` ✅

## 19) FOW 품질 프리셋 도입 + 저사양 성능 모드

- Fog of War 품질 레벨 추가
  - `low` / `medium` / `high` 프리셋 지원
  - 기본값을 `low`로 설정해 프레임 우선 정책 적용
- 적용 경로
  - `src/level/runtime/fogOfWarOverlay.ts`
    - 품질별 프로파일(해상도/갱신 임계치/경계 feather) 분리
    - `low`를 CPU 픽셀 루프에서 **cone fill + edge line(지오메트리 기반)** 경로로 전환(로직 자체 최적화)
    - `medium/high`는 기존 CPU + LOS 차폐(raycast) 경로 유지
    - `low`에서는 LOS 차폐(raycast) 연산 비활성화
  - `src/level/runtime/levelRuntime.ts`
    - 장애물 가시성 판정도 품질별 프로파일 적용
    - `low`에서는 장애물 반투명 처리(가시성 페이드) 비활성화
  - `src/app/gameApp.ts`
    - `?fow=low|medium|high` (`?fowQuality=`도 허용) 쿼리 파라미터로 품질 선택
    - `low`에서는 원격 플레이어 LOS 가시성 판정 비활성화(항상 표시)
    - FOW 품질에 맞춰 렌더 프로파일(AA/pixel ratio/shadow/tone mapping)을 함께 적용
    - 마지막 선택값을 localStorage(`wildpaw.fowQuality`)에 저장해 재접속 시 유지
  - `src/render/renderer.ts`, `src/render/lights.ts`
    - `low` 렌더 경로에서 저전력 프로파일 적용(AA off, DPR 0.75 상한 허용, shadow off, light 수 축소)
    - WebGL context `powerPreference=high-performance`, `stencil=false`로 불필요 버퍼 비용 축소
- 부트 옵션 확장
  - `src/app/bootstrap.ts`에 `fowQuality` 옵션 추가
- 검증
  - `npm run build` ✅
