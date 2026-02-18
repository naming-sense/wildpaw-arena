# 21. UX/UI 화면별 컴포넌트 상세명세서 (게임플로우 연동)

## 0) 문서 목적
`19_게임플로우_온보딩_로비_매칭_드래프트_UXUI_상세.md`의 흐름을 기반으로,
클라이언트가 바로 구현 가능한 **화면별 UI 컴포넌트 명세**를 정의한다.

이 문서는 다음을 포함한다.
- 컴포넌트 카탈로그(공통/화면전용)
- 각 컴포넌트의 상태(state), 데이터 바인딩, 이벤트
- 에러/빈상태/로딩 상태
- 접근성(A11y), 반응형, 로컬라이징 규칙

연동 문서:
- `19_게임플로우_온보딩_로비_매칭_드래프트_UXUI_상세.md`
- `20_게임플로우_API_이벤트_서버계약서.md`
- `03_아트_월드_UX가이드.md`

---

## 1) 정보 구조(IA)와 전역 네비게이션

## 1-1. 전역 레이아웃
```text
┌ TopBar (profile, currency, ping, notifications, settings)
├ Main Content (state-dependent screen)
└ BottomNav (Heroes / Shop / Pass / Missions / Career)
```

상태별 TopBar/BottomNav 표시 규칙:
- BOOT, AUTH, ONBOARDING: BottomNav 숨김
- LOBBY, PARTY, QUEUEING: TopBar + BottomNav 표시
- READY_CHECK, DRAFT, MATCH_LOADING: BottomNav 숨김
- IN_MATCH: 전투 HUD 전용 레이아웃
- RESULT: TopBar 축소형 + 결과 패널

---

## 2) 디자인 시스템 규약

## 2-1. 토큰 (권장)
- Color
  - `bg/base`, `bg/elevated`, `bg/danger`
  - `text/primary`, `text/secondary`, `text/inverse`
  - `team/ally`, `team/enemy`, `status/success`, `status/warn`, `status/error`
- Spacing: `4, 8, 12, 16, 20, 24, 32`
- Radius: `8, 12, 16`
- Shadow: `sm, md, lg`
- Motion: `fast(120ms), normal(220ms), slow(320ms)`

## 2-2. 컴포넌트 계층
- Atom: Button, Tag, Icon, Avatar, ProgressBar
- Molecule: HeroCard, QueueStatusCard, PartySlot
- Organism: DraftPanel, MatchFoundModal, ResultSummaryPanel
- Template: LobbyLayout, DraftLayout, InMatchLayout

## 2-3. UI 상태 표준
모든 인터랙티브 컴포넌트는 최소 상태를 갖는다.
- `default`
- `hover` (PC)
- `pressed`
- `disabled`
- `loading`
- `error` (필요 시)

---

## 3) 공통 컴포넌트 명세

## 3-1. `ButtonPrimary`
| 항목 | 내용 |
|---|---|
| 용도 | 핵심 액션(게임 시작, 수락, 잠금 등) |
| Props | `label`, `size(sm/md/lg)`, `disabled`, `loading`, `onClick` |
| 상태 | default/hover/pressed/disabled/loading |
| 이벤트 | click -> AppFlow event dispatch |

## 3-2. `ModalBase`
| 항목 | 내용 |
|---|---|
| 용도 | Match Found, Error, Confirm 등 |
| Props | `title`, `body`, `actions[]`, `closable`, `onClose` |
| 키보드 | `Esc` 닫기(선택), `Enter` 기본 액션 |
| 접근성 | focus trap, `aria-modal=true` |

## 3-3. `Toast`
| 항목 | 내용 |
|---|---|
| 타입 | info/success/warn/error |
| 노출 시간 | 2.5~4초 |
| 사용 예 | 큐 취소, 초대 수락, 연결 재시도 |

## 3-4. `NetworkBadge`
| 표시 규칙 |
|---|
| `ping < 60`: Good(녹색) |
| `60~100`: Normal(노랑) |
| `>100` 또는 packetLoss high: Warn(빨강) |

---

## 4) 화면별 상세 명세

## 4-1. BOOT 화면
### 컴포넌트
- `SplashLogo`
- `BootProgressBar`
- `BootStatusText`

### 상태
- `CHECK_VERSION`
- `PROBE_REGION`
- `RESTORE_SESSION`
- `ERROR`

### 주요 이벤트
- 완료: `EVT_BOOT_OK` -> AUTH
- 실패: `EVT_BOOT_FAIL` + 재시도 버튼

---

## 4-2. AUTH 화면
### 컴포넌트
- `AuthPanel`
  - `BtnGoogleLogin`
  - `BtnAppleLogin`
  - `BtnGuestStart`
- `AuthErrorInline`

### 입력/상태
- 로그인 요청 중 버튼 disabled + spinner
- 실패 시 인라인 오류 + 재시도 CTA

### API 연결
- `C2S_AUTH_LOGIN`, `C2S_AUTH_GUEST`

---

## 4-3. ONBOARDING 화면
### 컴포넌트
- `NicknameInput`
- `TermsCheckboxGroup`
- `TutorialStartCard`
- `StarterHeroSelector`

### 검증
- 닉네임 길이 2~12
- 금칙어 필터
- 약관 미동의 시 진행 버튼 disabled

### 완료 액션
- `C2S_ONBOARDING_COMPLETE`

---

## 4-4. LOBBY 화면
### 레이아웃
```text
[TopBar]
[Main: ModeCards + QuickStart + HeroPreview]
[Side: PartyPanel]
[BottomNav]
```

### 핵심 컴포넌트
1. `ModeCardList`
   - 모드, 예상시간, 팀크기
2. `QuickStartCTA`
   - 현재 모드 기준 큐 진입
3. `PartyPanel`
   - 슬롯, 초대, 준비 상태
4. `HeroPreviewPanel`
   - 현재 기본 히어로/스킨

### 상호작용
- `게임 시작` 클릭 -> `EVT_QUEUE_JOIN_REQUEST`
- 파티 리더 변경 시 Panel 리렌더

---

## 4-5. PARTY 화면(오버레이/독립)
### 컴포넌트
- `PartyMemberList`
- `InviteFriendModal`
- `PartyReadyToggle`
- `KickMenu`(리더)

### 상태
- 파티원 1~5
- 리더/일반 멤버 권한 분기

### 이벤트
- `C2S_PARTY_INVITE`, `C2S_PARTY_LEAVE`, `C2S_PARTY_READY_TOGGLE`

---

## 4-6. QUEUEING 화면
### 컴포넌트
- `QueueTimer`
- `EstimatedWaitCard`
- `SearchRangeChip`
- `CancelQueueButton`
- `QueueTipCarousel`

### 데이터 바인딩
- `elapsedSec`, `estimatedWaitSec`, `searchRange.maxPingMs`, `searchRange.srRange`

### UX 규칙
- 취소 버튼은 항상 동일 위치
- 대기 30초 이상 시 팁 자동 갱신

---

## 4-7. MATCH FOUND 모달 (READY_CHECK)
### 컴포넌트
- `MatchFoundModal`
  - `CountdownRing(10s)`
  - `AcceptButton`
  - `DeclineButton`

### 상태
- 3초 이하 시 경고 애니메이션
- Accept 후 버튼 잠금 + "대기중"

### 이벤트
- `C2S_MATCH_ACCEPT{accept:true/false}`

---

## 4-8. DRAFT 화면
### 레이아웃
```text
[Team A Picks] [Center: Timer/Map/Phase] [Team B Picks]
[HeroGrid + Filters]
[RecommendedPanel + TeamCompWarnings]
[Bottom: HoverInfo + Lock Button]
```

### 핵심 컴포넌트
1. `DraftPhaseHeader`
   - 현재 단계(밴/픽), 턴 주체, 남은시간
2. `HeroGrid`
   - 상태: `available`, `banned`, `pickedByAlly`, `pickedByEnemy`, `disabled`
3. `TeamCompWarning`
   - 탱커 없음, 힐러 없음 등
4. `DraftLockButton`
   - hover만 한 상태에선 disabled

### UX 규칙
- 남은 시간 5초 미만 경고 컬러 전환
- 내 턴 아닐 때 입력 잠금 + 시각적 안내

### 이벤트
- `C2S_DRAFT_ACTION(HOVER/BAN/PICK/LOCK)`

---

## 4-9. MATCH LOADING 화면
### 컴포넌트
- `LoadingProgress`
- `MapInfoCard`
- `TeamLineupCards`
- `ConnectionStateBadge`

### 상태
- `ALLOCATING_ROOM`
- `CONNECTING_ROOM`
- `SYNCING_WORLD`
- `READY`

### 실패 UX
- 연결 실패 시 재시도 카운터 표시
- 2회 실패 후 큐 복귀 안내 모달

---

## 4-10. IN_MATCH HUD
### 영역
- 좌상: `PlayerVitals` (HP/실드/상태이상)
- 우하: `WeaponAndSkillHUD` (탄약, 재장전, Q/E/R)
- 상단 중앙: `ObjectiveHeader` (점수/타이머)
- 좌하: `Minimap`
- 중앙: `Crosshair` + 히트마커

### HUD 컴포넌트 상세
1. `AmmoWidget`
   - `ammo/maxAmmo`, 재장전 progress
2. `SkillButtonQER`
   - 상태: `ready`, `cooldown`, `casting`, `disabled`
3. `RespawnPanel`
   - 사망 시만 표시
4. `PingWheel`
   - 단축키(MMB/Alt)

### 성능 가이드
- HUD는 30Hz로 상태 업데이트, 애니메이션은 CSS/캔버스 보간
- 킬로그 최대 6줄 유지

---

## 4-11. RESULT 화면
### 컴포넌트
- `ResultBanner` (승/패)
- `ScoreBreakdown`
- `PersonalStatsPanel`
- `RewardPanel`
- `MVPCard`
- `ResultActions` (Rematch / Next Match / Lobby)

### 행동 규칙
- Rematch는 파티원 상태 동기화 필요
- Rank 모드는 Rematch 직행 시에도 Ready Check 유지

---

## 4-12. RECONNECTING 오버레이
### 컴포넌트
- `ReconnectOverlay`
  - 상태 문구
  - 남은 복귀 시간
  - 수동 재시도 버튼

### UX 규칙
- 인게임 위에 반투명 오버레이
- 입력 잠금, 카메라/연출 최소화

---

## 5) 컴포넌트-상태 전이 매핑

| 컴포넌트 | 사용자 액션 | Dispatch 이벤트 | 기대 상태 전이 |
|---|---|---|---|
| QuickStartCTA | 클릭 | EVT_QUEUE_JOIN_REQUEST | LOBBY -> QUEUEING |
| CancelQueueButton | 클릭 | EVT_QUEUE_CANCEL_REQUEST | QUEUEING -> LOBBY |
| AcceptButton | 클릭 | EVT_MATCH_ACCEPT_TRUE | READY_CHECK 유지 후 DRAFT |
| DraftLockButton | 클릭 | EVT_DRAFT_LOCK | DRAFT -> MATCH_LOADING |
| RematchButton | 클릭 | EVT_REMATCH_VOTE | RESULT -> READY_CHECK 또는 LOBBY |

---

## 6) 마이크로카피 가이드 (핵심 문구)

원칙:
- 짧고 명확하게
- 행동 유도형 문장
- 실패 시 해결 방법 제시

예시:
- 큐: "매치 찾는 중… (예상 45초)"
- 수락: "매치가 잡혔어요! 10초 안에 수락해 주세요."
- 드래프트 타임아웃: "시간 초과로 선호 히어로가 자동 선택됐어요."
- 룸 연결 실패: "룸 연결에 실패했어요. 다시 할당을 시도할게요."

---

## 7) 접근성(A11y) 규칙

1. 색상만으로 상태 전달 금지(아이콘/텍스트 동반)
2. 키보드 탐색 지원
   - `Tab`: 포커스 이동
   - `Enter/Space`: 버튼 실행
   - `Esc`: 모달 닫기(허용 모달만)
3. 텍스트 확대 125%, 150%에서도 레이아웃 깨짐 없음
4. 색약 모드에서 팀 색상 대비 기준 충족

---

## 8) 반응형/해상도 가이드

기본 타깃: PC 16:9
- 기준: 1920x1080
- 지원: 1600x900, 1366x768

규칙:
- 1366px 이하에서 사이드패널 접기
- 드래프트 HeroGrid 열 수 자동 축소
- 작은 해상도에서 채팅/로그 우선순위 축소

---

## 9) 로컬라이징(i18n) 규칙

- UI 텍스트는 key 기반 관리
  - 예: `lobby.quickStart`, `draft.lockIn`, `error.roomConnectFail`
- 숫자/시간 포맷 로케일별 렌더
- 텍스트 길이 증가 언어(EN/DE) 대비 최소 30% 여백 확보

---

## 10) QA 검수 체크리스트

### 상태/전이
- [ ] 상태별로 표시/숨김 컴포넌트가 정확한가
- [ ] 전이 중 버튼 중복 입력으로 이중 요청이 발생하지 않는가

### 에러/예외
- [ ] 서버 오류 코드별 사용자 안내가 정의되어 있는가
- [ ] 네트워크 끊김/복귀 시 오버레이가 정상 작동하는가

### 접근성
- [ ] 키보드만으로 핵심 흐름이 가능한가
- [ ] 색약 모드에서 팀/상태 식별이 가능한가

---

## 11) 구현 우선순위

P0:
- LOBBY, QUEUEING, MATCH_FOUND, DRAFT, MATCH_LOADING, IN_MATCH HUD, RESULT

P1:
- PARTY 관리, RECONNECTING 오버레이, 상세 에러 UX

P2:
- 커스텀 룸 전용 UI, 고급 Draft 분석 패널, 개인화 추천 강화

---

## 12) 결론
이 명세서의 핵심은 "예쁜 화면"이 아니라,
**상태 머신에 정확히 붙는 UI 컴포넌트 계약**을 만들어
개발/QA/운영이 같은 기준으로 움직이게 하는 것이다.

다음 액션:
1. 컴포넌트 ID를 실제 코드 네이밍 규칙과 맞춰 확정
2. `20_게임플로우_API_이벤트_서버계약서.md` 이벤트와 1:1 바인딩
3. 스토리북(Storybook) 기반 상태별 스냅샷 테스트 도입
