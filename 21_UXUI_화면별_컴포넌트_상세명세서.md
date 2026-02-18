# 21. UX/UI 화면별 컴포넌트 상세명세서 (구현 명세 v2)

## 0) 문서 목적
`19_게임플로우_온보딩_로비_매칭_드래프트_UXUI_상세.md` + `20_게임플로우_API_이벤트_서버계약서.md`를 기준으로,
실제 클라이언트 구현에 바로 적용 가능한 **화면별 UI 계약**을 정의한다.

이 문서의 필수 범위:
1. 화면별 컴포넌트 트리
2. 상태(State) 바인딩(클라 스토어/API/실시간 이벤트)
3. 이벤트 바인딩(UI 이벤트 ↔ C2S/S2C ↔ 상태 전이)
4. 접근성(A11y) 규칙
5. QA 체크리스트(기능/예외/회귀)

---

## 1) 구현 전제 (공통)

### 1-1. AppFlowState ↔ 화면 매핑

| AppFlowState | 화면 컴포넌트 루트 | BottomNav | 비고 |
|---|---|---|---|
| BOOT | `BootScreen` | 숨김 | 버전/리전/세션 복구 |
| AUTH | `AuthScreen` | 숨김 | 로그인/게스트 |
| ONBOARDING | `OnboardingScreen` | 숨김 | 닉네임/약관/튜토리얼 |
| LOBBY | `LobbyScreen` | 표시 | 모드/빠른 시작/파티 |
| PARTY | `PartyOverlay`(on Lobby) | 표시 | 오버레이 우선 |
| QUEUEING | `QueueScreen` | 표시 | 대기 상태 |
| READY_CHECK | `MatchFoundModal` | 숨김 | 10초 수락 확인 |
| DRAFT | `DraftScreen` | 숨김 | 픽/밴/락인 |
| MATCH_LOADING | `MatchLoadingScreen` | 숨김 | 룸 연결 |
| IN_MATCH | `InMatchLayout` | 숨김 | 전투 HUD |
| RESULT | `ResultScreen` | 축소형 TopBar | 승패/보상/리매치 |
| RECONNECTING | `ReconnectOverlay` | 상태 유지 | 인게임/로딩 공통 오버레이 |

### 1-2. 클라이언트 상태 슬라이스(권장)

- `appFlowStore`: flowState, previousState, modalStack, globalError
- `sessionStore`: accountId, sessionId, authProvider, isGuest
- `lobbyStore`: selectedModeId, selectedHeroId, partyState, quickStartEnabled
- `queueStore`: queueTicketId, elapsedSec, estimatedWaitSec, searchRange
- `readyCheckStore`: matchCandidateId, deadlineMs, acceptState
- `draftStore`: draftType, turnSeq, remainingSec, heroGridState, myLockState
- `loadingStore`: loadingPhase, retryCount, roomEndpoint, roomToken
- `matchHudStore`: hp/maxHp, ammo/maxAmmo, reload, q/e/r cooldown, minimap, killLog
- `resultStore`: result, score, rewards, rematchVotes
- `networkStore`: pingMs, packetLoss, wsState, reconnectDeadlineMs

### 1-3. 이벤트 처리 공통 규칙

1. UI 입력은 즉시 로컬 낙관적 반영 가능하나, 최종 상태는 S2C로 확정한다.
2. 모든 C2S 요청은 `requestId`를 부여한다.
3. 동일 액션 연타 방지: `loading=true` 동안 동일 버튼 disabled.
4. 실패는 토스트 + 원인별 복구 CTA를 함께 노출한다.
5. 서버 상태가 클라 상태와 충돌하면 서버 상태를 우선한다.

### 1-4. 접근성(A11y) 공통 규칙

- 키보드 탐색: `Tab`/`Shift+Tab`/`Enter`/`Space`/`Esc`
- 포커스 가시성: 모든 interactive 요소 `:focus-visible` 3:1 이상 대비
- 모달: focus trap + `aria-modal="true"` + 첫 포커스 지정
- 동적 상태 변경: `aria-live="polite"` (타이머 경고는 `assertive`)
- 색상 외 수단 제공: 아이콘/텍스트/패턴 병행

### 1-5. QA 공통 규칙

- 기능 테스트 + 상태 전이 테스트 + 예외 테스트를 함께 수행한다.
- Happy path만 통과하면 완료가 아님. 타임아웃/오류/재시도 포함 필수.
- 모든 화면은 1366x768 / 1920x1080 / 125% zoom에서 확인한다.

---

## 2) 공통 컴포넌트 계약

### 2-1. `ButtonPrimary`
- Props: `label`, `size`, `disabled`, `loading`, `onClick`, `ariaLabel`
- 상태: `default | hover | pressed | disabled | loading`
- 이벤트: click -> 도메인 이벤트 dispatch
- 접근성: `role="button"`, 키보드 Enter/Space 지원

### 2-2. `ModalBase`
- Props: `title`, `body`, `actions[]`, `closable`, `onClose`
- 접근성: `aria-modal`, `aria-labelledby`, focus trap
- QA: 스크롤 잠금/배경 클릭 close 정책 일관성

### 2-3. `ToastCenter`
- 타입: info/success/warn/error
- 표시시간: 2.5~4s
- 접근성: `aria-live="polite"`

### 2-4. `NetworkBadge`
- 입력: `pingMs`, `packetLoss`, `wsState`
- 상태 매핑:
  - Good: `<60ms`
  - Normal: `60~100ms`
  - Warn: `>100ms or packetLoss>3%`
- 접근성: 텍스트 수치 병기(예: `82ms · 보통`)

---

## 3) 화면별 구현 명세

## 3-1. BOOT (`BootScreen`)

### 컴포넌트
- `SplashLogo`
- `BootProgressBar`
- `BootStatusText`
- `RetryButton`(오류 시)

### 상태 바인딩
| UI 필드 | 소스 | 설명 |
|---|---|---|
| 진행 단계 | local boot phase | CHECK_VERSION/PROBE_REGION/RESTORE_SESSION |
| 진행률 | computed | 단계별 0~100 |
| 오류 메시지 | `appFlowStore.globalError` | 사용자 친화 문구 변환 |

### 이벤트 바인딩
| 트리거 | 클라 동작 | 서버 이벤트 | 성공 전이 | 실패 처리 |
|---|---|---|---|---|
| 앱 시작 | 부트 파이프라인 실행 | `C2S_BOOT_READY` | BOOT -> AUTH | `S2C_FORCE_UPDATE`/재시도 |
| 재시도 클릭 | 부트 재호출 | `C2S_BOOT_READY` | AUTH | 오프라인 안내 유지 |

### 접근성
- 진행 바: `role="progressbar"` + `aria-valuenow`
- 상태 텍스트는 스크린리더에서 읽히도록 `aria-live="polite"`

### QA
- [ ] 정상 부트 완료 시 AUTH 진입
- [ ] `S2C_FORCE_UPDATE` 수신 시 업데이트 모달 고정
- [ ] 네트워크 오프라인 복귀 후 재시도 성공

---

## 3-2. AUTH (`AuthScreen`)

### 컴포넌트
- `AuthPanel`
  - `BtnGoogleLogin`
  - `BtnAppleLogin`
  - `BtnGuestStart`
- `AuthErrorInline`

### 상태 바인딩
| UI 필드 | 소스 | 설명 |
|---|---|---|
| 버튼 활성 | `authPending` | 요청 중 모두 disabled |
| 에러 문구 | `sessionStore.authError` | provider별 메시지 매핑 |

### 이벤트 바인딩
| 트리거 | 클라 동작 | 서버 이벤트 | 성공 전이 | 실패 처리 |
|---|---|---|---|---|
| Google 클릭 | provider=google 로그인 요청 | `C2S_AUTH_LOGIN` | ONBOARDING/LOBBY | `S2C_AUTH_FAIL` 인라인 표시 |
| Guest 클릭 | deviceId 생성 | `C2S_AUTH_GUEST` | ONBOARDING/LOBBY | 재시도 버튼 노출 |

### 접근성
- 소셜 로그인 버튼 모두 명확한 `aria-label` 제공
- 오류 메시지 영역 `role="alert"`

### QA
- [ ] 요청 중 다중 클릭 방지
- [ ] 게스트 계정은 랭크 버튼 비활성(로비에서 확인)
- [ ] 인증 실패 코드별 문구 정상 매핑

---

## 3-3. ONBOARDING (`OnboardingScreen`)

### 컴포넌트
- `NicknameInput`
- `TermsCheckboxGroup`
- `TutorialStartCard`
- `StarterHeroSelector`
- `OnboardingCompleteButton`

### 상태 바인딩
| UI 필드 | 소스 | 설명 |
|---|---|---|
| 닉네임 유효성 | local validator + 서버 중복검사 | 길이/금칙어/중복 |
| 약관 동의 | local form state | 필수 체크 전 완료 버튼 비활성 |
| 스타터 히어로 | selection state | 최소 1개 선택 필요 |

### 이벤트 바인딩
| 트리거 | 클라 동작 | 서버 이벤트 | 성공 전이 | 실패 처리 |
|---|---|---|---|---|
| 완료 클릭 | 폼 검증 후 제출 | `C2S_ONBOARDING_COMPLETE` | LOBBY | 항목별 오류 강조 |

### 접근성
- 입력 오류는 필드 하단 텍스트 + `aria-invalid` 동시 적용
- 체크박스 그룹은 `fieldset/legend` 사용

### QA
- [ ] 약관 미동의 시 완료 불가
- [ ] 닉네임 중복 시 서버 에러가 필드에 귀속 표시
- [ ] 튜토리얼 스킵/완료 플래그 저장 검증

---

## 3-4. LOBBY (`LobbyScreen`)

### 컴포넌트
- `TopBar`
- `ModeCardList`
- `QuickStartCTA`
- `HeroPreviewPanel`
- `PartyPanel`
- `BottomNav`

### 상태 바인딩
| UI 필드 | 소스 | 설명 |
|---|---|---|
| 선택 모드 | `lobbyStore.selectedModeId` | 카드 선택 반영 |
| 빠른 시작 가능 | 파티 ready/권한/게스트 제한 | disabled 조건 명시 |
| 파티 슬롯 | `S2C_PARTY_STATE` | 실시간 갱신 |
| 핑 배지 | `networkStore.pingMs` | TopBar 고정 표시 |

### 이벤트 바인딩
| 트리거 | 클라 동작 | 서버 이벤트 | 성공 전이 | 실패 처리 |
|---|---|---|---|---|
| 빠른 시작 클릭 | 큐 요청 payload 구성 | `C2S_QUEUE_JOIN` | QUEUEING (`S2C_QUEUE_JOINED`) | `QUEUE_INVALID_MODE` 토스트 |
| 친구 초대 | 대상 선택 | `C2S_PARTY_INVITE` | PARTY 유지 | 초대 실패 토스트 |
| 파티 준비 토글 | ready 반영 | `C2S_PARTY_READY_TOGGLE` | 상태 유지 | 권한 오류 안내 |

### 접근성
- 모드 카드: `role="radio"` + 카드 그룹 `radiogroup`
- 빠른 시작 버튼: 현재 모드명을 `aria-label`에 포함

### QA
- [ ] 모드 변경 직후 빠른 시작 payload 모드 일치
- [ ] 파티 리더/멤버 권한 버튼 노출 정확성
- [ ] 네트워크 배지 값 갱신이 UI 끊김 없이 반영

---

## 3-5. PARTY (`PartyOverlay`)

### 컴포넌트
- `PartyMemberList`
- `InviteFriendModal`
- `PartyReadyToggle`
- `LeaderActions(Kick/Transfer)`

### 상태 바인딩
| UI 필드 | 소스 | 설명 |
|---|---|---|
| 멤버 목록 | `S2C_PARTY_STATE.members` | 상태/역할/핑 |
| 리더 권한 | `party.leaderId===myId` | 메뉴 노출 분기 |

### 이벤트 바인딩
| 트리거 | 클라 동작 | 서버 이벤트 | 성공 전이 | 실패 처리 |
|---|---|---|---|---|
| 파티 나가기 | 확인 모달 후 전송 | `C2S_PARTY_LEAVE` | LOBBY | 실패 토스트 |
| 내보내기 | 리더 액션 | `C2S_PARTY_KICK` | PARTY 유지 | 권한 에러 처리 |

### 접근성
- 멤버 리스트는 가상화 시에도 키보드 탐색 순서 보장

### QA
- [ ] 리더 이탈 시 자동 리더 승계 반영
- [ ] 초대 수락/거절 알림 토스트 정확성

---

## 3-6. QUEUEING (`QueueScreen`)

### 컴포넌트
- `QueueTimer`
- `EstimatedWaitCard`
- `SearchRangeChip`
- `CancelQueueButton`
- `QueueTipCarousel`

### 상태 바인딩
| UI 필드 | 소스 | 설명 |
|---|---|---|
| 경과 시간 | `S2C_QUEUE_STATUS.elapsedSec` | 1초 단위 |
| 예상 대기 | `estimatedWaitSec` | 서버 값 우선 |
| 검색 범위 | `searchRange.maxPingMs/srRange` | 확장 단계 표기 |

### 이벤트 바인딩
| 트리거 | 클라 동작 | 서버 이벤트 | 성공 전이 | 실패 처리 |
|---|---|---|---|---|
| 큐 취소 | cancel 요청 | `C2S_QUEUE_CANCEL` | LOBBY (`S2C_QUEUE_CANCELLED`) | 취소 실패 토스트 |
| 매치 발견 수신 | ReadyCheck 오픈 | `S2C_MATCH_FOUND` | READY_CHECK | 큐 상태 종료 |

### 접근성
- 경과 시간은 `aria-live="polite"`로 10초 단위 알림만 송출(과도한 읽기 방지)

### QA
- [ ] 큐 상태 푸시 누락 시 로컬 타이머 fallback 동작
- [ ] 취소 버튼 연타 시 C2S 1회만 전송

---

## 3-7. READY_CHECK (`MatchFoundModal`)

### 컴포넌트
- `MatchFoundModal`
  - `CountdownRing`
  - `AcceptButton`
  - `DeclineButton`

### 상태 바인딩
| UI 필드 | 소스 | 설명 |
|---|---|---|
| 남은 시간 | `readyCheckStore.deadlineMs` | 10초 카운트다운 |
| 버튼 상태 | `acceptState` | pending 시 disabled |

### 이벤트 바인딩
| 트리거 | 클라 동작 | 서버 이벤트 | 성공 전이 | 실패 처리 |
|---|---|---|---|---|
| 수락 클릭 | accept=true 전송 | `C2S_MATCH_ACCEPT` | DRAFT (`S2C_READY_CHECK_RESULT`) | timeout 시 큐복귀 |
| 거절 클릭 | accept=false 전송 | `C2S_MATCH_ACCEPT` | QUEUEING/LOBBY | 페널티 안내 |
| 시간 만료 | 자동 거절 처리 | (서버 timeout) | QUEUEING | `READY_TIMEOUT` 표시 |

### 접근성
- 3초 이하 카운트다운은 `aria-live="assertive"`로 1회 알림

### QA
- [ ] 수락 후 중복 클릭 불가
- [ ] 파티 상태에서 전체 수락 실패 시 큐 복귀 동작 확인

---

## 3-8. DRAFT (`DraftScreen`)

### 컴포넌트
- `DraftPhaseHeader`
- `TeamSlotPanel`
- `HeroGrid`
- `HeroFilterBar`
- `RecommendedPanel`
- `TeamCompWarning`
- `DraftLockButton`

### 상태 바인딩
| UI 필드 | 소스 | 설명 |
|---|---|---|
| 현재 턴/남은 시간 | `S2C_DRAFT_STATE.turnSeq/remainingSec` | 서버 authoritative |
| 히어로 상태 | `heroGridState` | available/banned/picked 등 |
| 락인 가능 여부 | `myHoverHeroId + turnOwner` | 내 턴 + 선택 상태 필요 |

### 이벤트 바인딩
| 트리거 | 클라 동작 | 서버 이벤트 | 성공 전이 | 실패 처리 |
|---|---|---|---|---|
| 히어로 hover | 미리보기 전송 | `C2S_DRAFT_ACTION(HOVER)` | 상태 유지 | 무시 가능 |
| 픽/밴 클릭 | 행동 전송 | `C2S_DRAFT_ACTION(PICK/BAN)` | 상태 갱신 | `DRAFT_INVALID_TURN` 안내 |
| 락인 클릭 | 확정 전송 | `C2S_DRAFT_ACTION(LOCK)` | MATCH_LOADING | `DRAFT_HERO_UNAVAILABLE` 강조 |
| 턴 타임아웃 | 서버 오토픽 반영 | `S2C_DRAFT_TIMEOUT_AUTOPICK` | MATCH_LOADING 또는 다음 턴 | 자동선택 토스트 |

### 접근성
- HeroGrid 셀은 `button` semantics + 선택 상태 `aria-pressed`
- 금지/선택 완료 셀은 `aria-disabled=true`

### QA
- [ ] 내 턴 아닐 때 모든 액션 잠금
- [ ] 서버와 클라 턴 불일치 시 서버 상태로 즉시 롤백
- [ ] 오토픽 발생 시 선택 결과/로그 동시 노출

---

## 3-9. MATCH_LOADING (`MatchLoadingScreen`)

### 컴포넌트
- `LoadingProgress`
- `MapInfoCard`
- `TeamLineupCards`
- `ConnectionStateBadge`
- `RetryHintPanel`

### 상태 바인딩
| UI 필드 | 소스 | 설명 |
|---|---|---|
| 로딩 단계 | `loadingStore.loadingPhase` | ALLOCATING/CONNECTING/SYNCING/READY |
| 재시도 횟수 | `loadingStore.retryCount` | 최대 2회 표시 |
| 팀 라인업 | `S2C_MATCH_ASSIGN.teamInfo + draft result` | 고정 목록 |

### 이벤트 바인딩
| 트리거 | 클라 동작 | 서버 이벤트 | 성공 전이 | 실패 처리 |
|---|---|---|---|---|
| 매치 할당 수신 | 룸 접속 시작 | `S2C_MATCH_ASSIGN` | IN_MATCH | 실패 시 재시도 |
| 룸 접속 실패 2회 | 큐 복구 요청 | `S2C_QUEUE_RECOVERY` | QUEUEING/LOBBY | 오류 모달 |

### 접근성
- 단계 전환 텍스트 `aria-live="polite"`

### QA
- [ ] 1차 실패 후 동일 룸 1회 재시도
- [ ] 토큰 만료(`MATCH_ASSIGN_EXPIRED`) 처리 검증

---

## 3-10. IN_MATCH (`InMatchLayout`)

### 컴포넌트
- `PlayerVitals`
- `WeaponAndSkillHUD`
- `ObjectiveHeader`
- `Minimap`
- `Crosshair`
- `HitMarkerLayer`
- `DamageOverlay`
- `KillLog`
- `RespawnPanel`
- `PauseMenu`

### 상태 바인딩
| UI 필드 | 소스 | 설명 |
|---|---|---|
| HP/상태이상 | 스냅샷 + 전투 이벤트 | 30Hz 갱신 |
| 탄약/재장전 | 로컬 예측 + authoritative 교정 | 재장전 progress 표시 |
| 스킬 쿨다운(Q/E/R) | `matchHudStore.cooldowns` | ready/cooldown/casting |
| 히트마커/피격오버레이 | `S2C_EVENT(hit-confirm/damage-taken)` | 단기 이펙트 |

### 이벤트 바인딩
| 트리거 | 클라 동작 | 서버 이벤트 | 성공 전이 | 실패 처리 |
|---|---|---|---|---|
| 입력(이동/사격/스킬) | command 송신 | Room realtime protocol | IN_MATCH 유지 | 패킷손실 경고 |
| 일시정지-항복 | 투표 요청 | `C2S_SURRENDER_VOTE`(확장) | RESULT/진행 | 실패 토스트 |
| 경기 종료 수신 | 결과 스냅샷 저장 | `S2C_MATCH_ENDED` | RESULT | 없음 |

### 접근성
- 크로스헤어 대체 옵션(두께/색상/투명도)
- 스킬 쿨다운은 숫자 남은시간 동시 표시
- 색약 모드 팀색 팔레트 지원

### QA
- [ ] FPS 저하 시 HUD 갱신 지연이 플레이블 수준 유지
- [ ] 킬로그 6줄 초과 시 오래된 항목부터 제거
- [ ] 사망-리스폰 UI 전환 시 입력 잠금/해제 정상

---

## 3-11. RESULT (`ResultScreen`)

### 컴포넌트
- `ResultBanner`
- `ScoreBreakdown`
- `PersonalStatsPanel`
- `RewardPanel`
- `MVPCard`
- `ResultActions(Rematch/Next/Lobby)`

### 상태 바인딩
| UI 필드 | 소스 | 설명 |
|---|---|---|
| 승패/스코어 | `S2C_MATCH_ENDED` | immutable |
| 보상 | rewards payload | RP/XP/재화 |
| 리매치 상태 | `S2C_REMATCH_STATE` | 파티원 동기화 |

### 이벤트 바인딩
| 트리거 | 클라 동작 | 서버 이벤트 | 성공 전이 | 실패 처리 |
|---|---|---|---|---|
| 리매치 클릭 | 투표 전송 | `C2S_REMATCH_VOTE` | READY_CHECK/DRAFT | 취소 시 LOBBY |
| 다음 경기 클릭 | 큐 재진입 | `C2S_QUEUE_JOIN` | QUEUEING | 실패 토스트 |
| 로비 이동 | 상태 초기화 | (local + optional notify) | LOBBY | 없음 |

### 접근성
- 승/패 배너는 아이콘 + 텍스트 동시 표기

### QA
- [ ] 리매치 투표 상태가 파티원별로 실시간 반영
- [ ] 랭크 모드에서 리매치 시 READY_CHECK 유지

---

## 3-12. RECONNECTING (`ReconnectOverlay`)

### 컴포넌트
- `ReconnectOverlay`
  - `ReconnectStatusText`
  - `ReconnectCountdown`
  - `RetryNowButton`

### 상태 바인딩
| UI 필드 | 소스 | 설명 |
|---|---|---|
| 연결 상태 | `networkStore.wsState` | disconnected/retrying/restored |
| 복귀 제한 시간 | `reconnectDeadlineMs` | 20초 기준 |

### 이벤트 바인딩
| 트리거 | 클라 동작 | 서버 이벤트 | 성공 전이 | 실패 처리 |
|---|---|---|---|---|
| 네트워크 단절 | 오버레이 노출 + 자동 재시도 | reconnect loop | 이전 상태 복귀 | 시간 만료 시 RESULT |
| 수동 재시도 | 즉시 reconnect 시도 | reconnect loop | 복귀 | `RECONNECT_WINDOW_EXPIRED` |

### 접근성
- 오버레이 등장 시 포커스 이동, 복귀 시 원래 포커스 복원

### QA
- [ ] 20초 내 복귀 시 전투 상태 복원
- [ ] 만료 시 페널티/결과 처리 일관성

---

## 4) 전역 이벤트 바인딩 매트릭스 (UI 기준)

| UI 액션 | Dispatch | C2S | 기대 S2C | 상태 전이 |
|---|---|---|---|---|
| 게임 시작 클릭 | `EVT_QUEUE_JOIN_REQUEST` | `C2S_QUEUE_JOIN` | `S2C_QUEUE_JOINED` | LOBBY -> QUEUEING |
| 큐 취소 클릭 | `EVT_QUEUE_CANCEL_REQUEST` | `C2S_QUEUE_CANCEL` | `S2C_QUEUE_CANCELLED` | QUEUEING -> LOBBY |
| 매치 수락 | `EVT_MATCH_ACCEPT_TRUE` | `C2S_MATCH_ACCEPT` | `S2C_READY_CHECK_RESULT(ALL_ACCEPTED)` | READY_CHECK -> DRAFT |
| 드래프트 락인 | `EVT_DRAFT_LOCK` | `C2S_DRAFT_ACTION(LOCK)` | `S2C_DRAFT_STATE`/종료 | DRAFT -> MATCH_LOADING |
| 리매치 투표 | `EVT_REMATCH_VOTE` | `C2S_REMATCH_VOTE` | `S2C_REMATCH_START/CANCELLED` | RESULT -> READY_CHECK/LOBBY |

---

## 5) 접근성 상세 체크리스트 (출시 게이트)

- [ ] 모든 클릭 가능한 요소가 키보드 접근 가능
- [ ] 모달/오버레이에서 포커스 트랩과 복귀가 정상
- [ ] 카운트다운/중요 상태는 SR에서 과도하지 않게 안내
- [ ] 색약 모드에서 팀/경고/성공 상태 구분 가능
- [ ] 텍스트 150% 확대 시 주요 CTA 잘림 없음

---

## 6) QA 테스트 시나리오 (필수)

### 6-1. 플로우 E2E
- [ ] BOOT -> AUTH -> ONBOARDING -> LOBBY -> QUEUEING -> READY_CHECK -> DRAFT -> MATCH_LOADING -> IN_MATCH -> RESULT

### 6-2. 예외 플로우
- [ ] READY_CHECK 무응답 -> 큐 복귀 + 페널티 안내
- [ ] DRAFT 타임아웃 -> 오토픽 + 로그 표시
- [ ] MATCH_LOADING 2회 실패 -> 큐 복구
- [ ] IN_MATCH 중 단절 -> RECONNECTING -> 복귀/만료 분기

### 6-3. 회귀 포인트
- [ ] 버튼 연타 시 중복 C2S 요청 없음
- [ ] 서버 authoritative 상태로 UI가 롤백 가능한지
- [ ] 토스트/모달 중복 노출(스택 꼬임) 없음

### 6-4. 자동화 권장
- 상태 스냅샷 테스트(Storybook/Playwright)
- 이벤트 리플레이 테스트(mock gateway)
- A11y lint + axe-core smoke 테스트

---

## 7) 구현 우선순위

### P0 (즉시)
- LOBBY, QUEUEING, READY_CHECK, DRAFT, MATCH_LOADING, IN_MATCH HUD, RESULT

### P1
- PARTY 오버레이 고도화, RECONNECTING 고도화, 오류 코드별 카피 세분화

### P2
- 커스텀 룸 전용 UI, 고급 추천 패널, 개인화 옵션

---

## 8) 완료 기준(Definition of Done)

각 화면은 아래 5가지를 모두 충족해야 완료로 인정한다.
1. 컴포넌트 트리 구현 완료
2. 상태 바인딩(스토어/이벤트) 완료
3. C2S/S2C 이벤트 바인딩 완료
4. A11y 체크리스트 통과
5. QA 시나리오(정상+예외) 통과

---

## 9) 결론
이 문서의 목표는 디자인 설명이 아니라,
**화면 컴포넌트 + 상태 + 이벤트 + 접근성 + QA를 하나의 구현 계약으로 고정**하는 것이다.

다음 액션:
1. 본 문서 기준으로 화면별 스토리북 상태(state stories) 생성
2. `20_게임플로우_API_이벤트_서버계약서.md`와 이벤트 필드 1:1 검증
3. QA 자동화(playwright + axe) 기본 파이프라인 연결
