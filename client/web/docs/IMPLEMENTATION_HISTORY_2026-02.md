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
