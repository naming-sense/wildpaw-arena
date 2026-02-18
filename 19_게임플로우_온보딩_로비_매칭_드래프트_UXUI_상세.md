# 19. 게임플로우 + UX/UI 상세 설계 (온보딩~로비~매칭~드래프트~경기)

## 0) 문서 목적
현재 "실행 즉시 전투 진입" 상태에서 발생하는 설계 공백을 메우기 위해,
**처음 실행부터 매치 종료까지의 전체 사용자 흐름**과 **필수 UX/UI 화면/상태 전이**를 정의한다.

핵심 목표:
1. 흐름 누락(방 생성/매칭/게임 시작/캐릭터 선택/예외 처리) 제거
2. 클라이언트/서버가 같은 상태 머신으로 동작하도록 계약 정리
3. QA 가능한 수준의 타임아웃/실패 처리 규칙까지 포함

연동 문서:
- `01_게임비전_코어루프.md`
- `03_아트_월드_UX가이드.md`
- `08_매치메이킹_랭크_시스템_상세.md`
- `10_데이터_텔레메트리_AB테스트_스펙.md`
- `18_캐릭터_무기_전투_클라이언트_개발계획서.md`
- `server/SERVER_SPEC.md`

---

## 1) 문제 정의 (현재 공백)

현재 상태(문제):
- 앱 실행 → 전투 화면 직행
- 누락:
  - 로그인/게스트 흐름
  - 튜토리얼/약관/닉네임
  - 로비 정보 구조(모드 선택, 파티, 캐릭터 준비)
  - 매칭 큐 진입/취소/예상 대기시간
  - 매치 성사 후 Ready Check
  - 캐릭터 선택(중복/충돌 처리)
  - 매치 실패/재할당/재접속 프로세스

목표 상태:
- 사용자 입장에서 "왜 지금 이 화면인지"가 항상 명확한 흐름
- 개발자 입장에서 상태 전이가 deterministic한 구현 구조

---

## 2) End-to-End 상태 머신 (정의본)

```text
BOOT
 -> AUTH
 -> ONBOARDING
 -> LOBBY
 -> PARTY(optional)
 -> QUEUEING
 -> READY_CHECK
 -> DRAFT
 -> MATCH_LOADING
 -> IN_MATCH
 -> RESULT
 -> (REMATCH -> READY_CHECK) or (LOBBY)
```

에러/예외 공통 분기:
- `NETWORK_LOST` -> `RECONNECTING` -> (복귀 성공 시 이전 상태 복귀)
- `MATCH_ALLOCATION_FAIL` -> `QUEUE_RECOVERY` -> QUEUEING 또는 LOBBY
- `DRAFT_TIMEOUT` -> `AUTO_PICK` -> MATCH_LOADING

---

## 3) 최초 실행 플로우 (First Launch)

## 3-1. BOOT
1. 버전 체크 (강제 업데이트 여부)
2. 리전 핑 샘플링 (KR/JP/SG 후보)
3. 계정 토큰 확인

실패 처리:
- 버전 불일치: 업데이트 안내 모달 + 재시도
- 네트워크 불가: 오프라인 에러 화면 + 재접속 버튼

## 3-2. AUTH
옵션:
- 게스트 시작
- 플랫폼 로그인(구글/애플/디스코드 등)
- 기존 계정 로그인

규칙:
- 게스트는 기기 로컬 ID 발급
- 랭크 진입/과금/친구초대 기능은 로그인 계정만 허용(게스트 제한)

## 3-3. ONBOARDING
- 닉네임 입력(중복 검증)
- 약관/개인정보 동의
- 조작 튜토리얼(60~90초)
- 기본 히어로 1~2개 선택

완료 시:
- 로비 진입 + 초보자 미션 노출

---

## 4) 로비 정보 구조 (Lobby IA)

## 4-1. 상단 글로벌 바
- 프로필/레벨/통화
- 네트워크 상태(핑)
- 알림(친구 초대/보상 수령)
- 설정

## 4-2. 중앙 메인 패널
- `빠른 시작` CTA (가장 큰 버튼)
- 모드 선택 카드 (3v3 일반/랭크, 5v5, 이벤트)
- 현재 선택 히어로 프리뷰

## 4-3. 우측 사이드 패널
- 파티 슬롯(초대/내보내기/리더 표시)
- 준비 상태 표시
- 음성/핑 옵션

## 4-4. 하단 탭
- 히어로
- 스킨/상점
- 배틀패스
- 미션
- 커리어(전적)

UX 원칙:
- "게임 시작" 동선은 2클릭 이내
- 파티/큐 상태는 항상 상단에 고정 노출

---

## 5) 방 생성/파티 플로우

> 방(Room)은 2가지 방식으로 생성된다.

1) **자동 매칭 Room** (일반 사용자 기본)
- 사용자는 큐만 참여
- Matchmaker가 룸 할당/생성

2) **커스텀 Room** (친구전/테스트)
- 사용자가 방 생성 + 초대코드 공유
- 랭크/보상은 기본 비활성

## 5-1. 자동 매칭(권장 기본)
- 로비에서 모드 선택
- `게임 시작` 클릭 → Queue Ticket 발급
- 서버가 적정 인원 조합 후 Room 생성/할당

## 5-2. 커스텀 방 (선택 기능)
필수 UI:
- 방 제목/모드/팀 크기
- 비밀번호/초대코드
- 관전자 허용 여부
- 시작 권한(방장)

커스텀 방 권장 규칙:
- 최소 인원(예: 3v3은 4명 이상)부터 시작 허용
- 시작 시점에 캐릭터 중복 허용 여부 옵션

---

## 6) 매치메이킹 상세 플로우 (Queueing)

## 6-1. 큐 진입 시 payload
- modeId (3v3_normal / 3v3_rank / 5v5...)
- regionPreference
- partyId
- hiddenMMR, RD (서버 보유)
- 입력 디바이스 타입(선택)

## 6-2. 대기 화면 UX
표시 요소:
- 경과 시간
- 예상 대기시간
- 현재 검색 범위(핑/SR)
- 큐 취소 버튼
- 팁/미션 진행도

## 6-3. 확장 규칙 (08 문서 연동)
- 핑: 80 → 110 → 140ms
- SR 허용: ±70 → ±120 → ±180
- 파티 대칭 우선 (Solo vs Solo, Trio vs Trio)

## 6-4. 큐 취소
- 일반 큐: 즉시 취소
- 랭크 Ready Check 이후 취소: 페널티 적용

---

## 7) Match Found / Ready Check / Draft

## 7-1. Match Found (수락 확인)
- 팝업: "매치 찾음"
- 카운트다운: 10초
- 버튼: `수락` / (무응답 자동 거절)

실패 규칙:
- 1명이라도 거절/무응답이면 매치 취소
- 수락자 전원은 큐로 복귀
- 반복 무응답 유저는 큐 페널티

## 7-2. Draft(캐릭터 선택) 단계

### 모드별 제안
- 3v3 일반: **빠른 픽**(동시 선택 20초)
- 3v3 랭크: **턴제 픽/밴**(밴 1 + 픽 3)
- 5v5 일반: 동시 픽 + 팀 중복 제한 옵션

### Draft UI 필수 요소
- 팀별 슬롯(잠금 상태/선택 상태)
- 남은 시간
- 추천 히어로(역할군 밸런스 기반)
- 팀 조합 경고(예: 탱커 없음)
- 내 사전 선호 히어로(Preferred Picks)

### 타임아웃 처리
- 일반: 선호 히어로 자동 픽
- 랭크: 우선순위 리스트 기반 자동 픽 + 패널티 로그

## 7-3. Loadout 확정
- 히어로 선택 후
  - 스킨
  - 이모트/스프레이
  - 감도/크로스헤어 프리셋
확정 버튼 제공

---

## 8) Match Loading / 게임 시작

## 8-1. 로딩 화면
- 맵/모드 설명
- 양팀 히어로 카드
- 팁(카운터/오브젝트 포인트)
- 로딩 진행률 + 연결상태 표시

## 8-2. 서버 입장
- Matchmaker -> room token 발급
- 클라가 room 서버 접속 (`HelloPayload`)
- `WelcomePayload` 수신 후 로딩 완료

## 8-3. 경기 시작 전 워밍업(권장)
- 3초 카운트다운
- 이동 가능 / 공격 불가
- 시작 신호 후 공격 활성

---

## 9) 인게임 흐름 + UX

## 9-1. 전투 HUD (필수)
- 좌측: HP/상태이상
- 우측: 탄약/재장전 + Q/E/R 쿨다운
- 상단: 목표 점수/시간/오브젝트 상태
- 미니맵: 팀원/목표 핑

## 9-2. 인게임 시스템 UX
- 핑 휠(공격/수비/집합)
- 킬로그
- 리스폰 타이머 + 관전 전환
- 네트워크 경고(핑 급등/패킷 손실)

## 9-3. 일시정지 메뉴
- 설정(감도/그래픽/오디오)
- 항복 투표(모드 제한)
- 나가기(페널티 경고)

---

## 10) 경기 종료 / 결과 / 리매치

## 10-1. 결과 화면 구조
1. 승패/점수 요약
2. 개인 성과(킬/데스/어시스트/오브젝트 기여)
3. 보상(RP/경험치/미션 진행)
4. MVP/하이라이트

## 10-2. 후속 액션
- 리매치(같은 파티 유지)
- 다음 경기(큐 복귀)
- 로비 이동
- 신고/차단

## 10-3. 리매치 규칙
- 전원 동의 시 즉시 Ready Check 스킵하고 Draft로 이동(일반 모드만)
- 랭크는 매번 Ready Check 유지

---

## 11) 예외/장애 플로우 (구멍 방지 핵심)

## 11-1. 네트워크 끊김
- `RECONNECTING` 오버레이 표시
- 20초 내 복귀 시 경기 재합류
- 초과 시 이탈 처리 + 페널티 규칙 적용

## 11-2. 드래프트 중 이탈
- 자동 픽 후 경기 진행(팀 보호)
- 반복 이탈자는 랭크 큐 제한

## 11-3. 룸 할당 실패/가득 참
- "서버 재할당 중" 상태 표시 (최대 2회 재시도)
- 실패 시 큐 복귀 또는 로비 반환

## 11-4. 중복 계정 접속
- 기존 세션 강제 종료/복귀 선택 모달

## 11-5. 패치 핫업데이트
- 매치 중: 경기 종료 후 업데이트 유도
- 로비/큐 중: 강제 재시작 안내

---

## 12) UX/UI 화면 명세 (와이어프레임 수준)

## 12-1. 로비
```text
[TopBar: Profile | Currency | Ping | Settings]
[Main: Mode Cards + Start Button]
[Right: Party Slots + Invite]
[Bottom Tabs: Heroes / Shop / Pass / Missions / Career]
```

## 12-2. 큐 화면
```text
[Queue Timer]
[Estimated Wait]
[Search Range: Ping/SR Expansion]
[Cancel Queue]
[Tips / Mission Progress]
```

## 12-3. 매치 수락
```text
[MATCH FOUND!]
[Countdown 10s]
[Accept Button]
[Decline/Timeout = Queue Penalty 안내]
```

## 12-4. 드래프트
```text
[Team A Picks] [Map/Mode/Timer] [Team B Picks]
[Hero Grid + Filters(Role/Range/Difficulty)]
[Recommended Picks + Team Comp Warning]
[Lock In Button]
```

## 12-5. 결과
```text
[Victory/Defeat Banner]
[Stats + RP/XP]
[MVP Card]
[Rematch] [Next Match] [Back to Lobby]
```

---

## 13) 클라이언트 상태 모델 (구현용)

```ts
export type AppFlowState =
  | 'BOOT'
  | 'AUTH'
  | 'ONBOARDING'
  | 'LOBBY'
  | 'PARTY'
  | 'QUEUEING'
  | 'READY_CHECK'
  | 'DRAFT'
  | 'MATCH_LOADING'
  | 'IN_MATCH'
  | 'RESULT'
  | 'RECONNECTING';
```

필수 전이 이벤트:
- `EVT_LOGIN_SUCCESS`
- `EVT_QUEUE_JOINED`
- `EVT_MATCH_FOUND`
- `EVT_READY_CONFIRMED`
- `EVT_DRAFT_LOCKED`
- `EVT_ROOM_CONNECTED`
- `EVT_MATCH_ENDED`
- `EVT_RECONNECT_SUCCESS/FAIL`

---

## 14) 서버/클라 계약 이벤트 (추가 제안)

매치 전용 제어 이벤트(게이트웨이/매처):
- `S2C_QUEUE_STATUS`
- `S2C_MATCH_FOUND`
- `C2S_MATCH_ACCEPT`
- `S2C_READY_CHECK_RESULT`
- `S2C_DRAFT_START`
- `C2S_DRAFT_PICK`
- `S2C_DRAFT_STATE`
- `S2C_MATCH_ASSIGN` (room token, endpoint)

룸 전투 이벤트(이미 존재):
- `WelcomePayload`
- `SnapshotPayload`
- `CombatEventPayload`
- `ProjectileEventPayload`

---

## 15) 텔레메트리/검수 포인트 (10 문서 연동)

필수 이벤트:
- `first_open`
- `auth_complete`
- `tutorial_complete`
- `queue_join/cancel/match_found/accept`
- `draft_enter/pick/timeout/autopick`
- `match_start/end`
- `reconnect_attempt/success/fail`

핵심 KPI:
1. 앱 실행→첫 매치 시작 시간
2. 큐 취소율 / 수락 실패율
3. 드래프트 타임아웃률
4. 로딩 실패율
5. 첫날 유저의 2판 이상 플레이 비율

---

## 16) 구현 단계 제안 (우선순위)

## Phase 1 (필수)
- BOOT/AUTH/LOBBY/QUEUEING/IN_MATCH/RESULT 최소 플로우
- 매치 수락(Ready Check) 추가

## Phase 2
- DRAFT(동시 픽) + 선호 히어로 자동 픽
- 파티 초대/해제

## Phase 3
- 랭크용 픽/밴
- 커스텀 룸
- 재접속/이탈 페널티 고도화

---

## 17) QA 체크리스트 (흐름 누락 방지)
- [ ] 로그인 없이 랭크 진입 차단되는가
- [ ] 큐 취소/수락/무응답 시 상태 전이가 정상인가
- [ ] 드래프트 타임아웃 시 자동픽이 정상 동작하는가
- [ ] 룸 재할당 실패 시 사용자에게 명확히 안내되는가
- [ ] 경기 종료 후 리매치/로비 이동이 안정적인가
- [ ] 모든 상태에서 뒤로가기/닫기 동작이 정의되어 있는가

---

## 18) 결론
이 문서의 핵심은 "화면 추가"가 아니라,
**게임 시작 전/중/후의 상태 전이를 계약으로 고정**해서
- 유저는 혼란이 없고,
- 개발팀은 구현/디버깅/QA가 가능한 구조를 확보하는 것이다.

다음 액션:
1. 본 문서 상태 머신을 클라이언트 전역 상태로 반영
2. 매칭/드래프트 제어 이벤트를 게이트웨이 API로 확정
3. QA 시나리오 기반으로 1차 플로우 테스트 진행
