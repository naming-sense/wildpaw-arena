# Model/Animation Test Client Page Plan

## 1) 목적

현재 게임 루프(네트워크/입력/카메라)와 분리해서 **3D 모델 + 애니메이션 자산 자체**를 빠르게 검증할 수 있는 전용 페이지를 만든다.

핵심 목표:
- 모델 로드 성공/실패를 즉시 확인
- 클립별 재생 상태를 눈으로 확인
- 스켈레톤/바운딩박스/메시 통계를 통해 문제 원인(링만 보임, 위치 이탈, 스킨 변형)을 분리
- 게임 코드 수정 없이 자산 교체 테스트 반복

## 2) 제공 경로

- 전용 페이지: `/model-lab.html`
- 기존 게임 페이지(`/`)와 완전히 분리

## 3) UX/레이아웃

- 좌측: 테스트 패널
  - Asset preset 선택 + 직접 GLB 경로 입력 + Load 버튼
  - Clip 선택
  - Play/Pause, Reset, Fit Camera
  - Speed, Timeline 스크럽
  - 옵션 토글(Loop, Skeleton, Wireframe, Grid, Axes, Bounds, Freeze position tracks)
- 우측: 3D 캔버스
- 하단 정보 패널:
  - 로드 상태/에러
  - mesh, skinned mesh, bones, vertices, triangles
  - clip 목록/길이
  - 현재 bbox 크기/중심/원점 이탈 거리

## 4) 기능 요구사항

1. GLB 로딩
   - preset 또는 직접 입력 경로 로드
   - 실패 시 에러 메시지 노출
2. 애니메이션 재생
   - clip select
   - play/pause
   - speed 조절
   - timeline 스크럽
3. 디버그 시각화
   - skeleton helper
   - wireframe
   - bounds box
   - grid/axes on/off
4. 자산 검증 보조
   - `Freeze *.position tracks` 옵션으로 position track 첫 키프레임 고정 재생
   - bbox/중심값 실시간 갱신
5. 카메라 제어
   - OrbitControls
   - Fit Camera

## 5) 구현 범위(이번 작업)

- [x] `/model-lab.html` 신규 페이지 추가
- [x] `src/model-lab/main.ts` 전용 Three.js 테스트 앱 구현
- [x] `src/model-lab/style.css` UI 스타일 구현
- [x] `vite build`에서 `model-lab.html`도 출력되도록 설정
- [x] build/test 통과 및 preview 반영

## 6) 수용 기준

- `/model-lab.html` 접속 시 페이지가 정상 렌더링된다.
- 기본 preset 자산 로드 후 clip 재생/전환이 동작한다.
- skeleton/wireframe/bounds 토글이 즉시 반영된다.
- timeline 스크럽 시 원하는 시점으로 이동한다.
- 모델 통계/바운딩 정보가 표시된다.
