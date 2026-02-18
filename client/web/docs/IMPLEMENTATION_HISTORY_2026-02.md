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
