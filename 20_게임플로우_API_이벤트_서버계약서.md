# 20. 게임플로우 API 이벤트 서버 계약서 (온보딩·로비·매칭·드래프트)

## 0) 문서 목적
`19_게임플로우_온보딩_로비_매칭_드래프트_UXUI_상세.md`를 실제 구현 가능한 **클라이언트↔서버 계약**으로 고정한다.

이 문서는 다음을 정의한다.
- 상태 전이별 C2S/S2C 이벤트
- 이벤트 payload 스키마
- 타임아웃/재시도/멱등성 규칙
- 오류 코드 및 복구 흐름
- 룸 서버(전투) 프로토콜로 넘기는 경계

연동 문서:
- `19_게임플로우_온보딩_로비_매칭_드래프트_UXUI_상세.md`
- `08_매치메이킹_랭크_시스템_상세.md`
- `server/SERVER_SPEC.md`
- `shared/protocol/fbs/wildpaw_protocol.fbs`

---

## 1) 시스템 경계

## 1-1. 채널 분리
1. **Gateway Control Channel** (본 문서)
   - 로그인, 파티, 큐, 레디체크, 드래프트, 매치 할당
2. **Room Realtime Channel** (`SERVER_SPEC`)
   - 전투 입력/스냅샷/전투 이벤트

즉, **MATCH_ASSIGN 이전까지는 Gateway**, 이후 전투는 **Room Server**를 사용한다.

## 1-2. 연결 형태
- 권장: WebSocket(JSON) control channel + HTTP fallback 일부
- 전투 채널: WebSocket binary(FlatBuffers)

---

## 2) 공통 Envelope 규격

모든 control 이벤트는 아래 envelope를 사용한다.

```json
{
  "event": "C2S_QUEUE_JOIN",
  "eventId": "uuid-v7",
  "requestId": "client-generated-id",
  "sessionId": "session_abc",
  "ts": 1760781245123,
  "payload": {}
}
```

### 필드 의미
- `event`: 이벤트 이름(문서 표준)
- `eventId`: 이벤트 고유 ID(서버/클라 디듀프 키)
- `requestId`: 요청-응답 매칭 ID
- `sessionId`: 인증 이후 세션 ID
- `ts`: epoch ms
- `payload`: 이벤트별 본문

---

## 3) 상태 머신 계약 (요약)

| 현재 상태 | 이벤트 | 다음 상태 | 타임아웃/예외 |
|---|---|---|---|
| BOOT | C2S_BOOT_READY | AUTH | 버전 불일치 → FORCE_UPDATE |
| AUTH | C2S_AUTH_LOGIN / GUEST | ONBOARDING 또는 LOBBY | 인증 실패 → AUTH |
| ONBOARDING | C2S_ONBOARDING_COMPLETE | LOBBY | 저장 실패 → ONBOARDING |
| LOBBY | C2S_QUEUE_JOIN | QUEUEING | 큐 실패 → LOBBY |
| QUEUEING | S2C_MATCH_FOUND | READY_CHECK | 10초 무응답 → 큐 페널티 |
| READY_CHECK | C2S_MATCH_ACCEPT | DRAFT | 거절자 발생 → QUEUEING 복귀 |
| DRAFT | C2S_DRAFT_LOCK | MATCH_LOADING | 타임아웃 → AUTO_PICK |
| MATCH_LOADING | S2C_MATCH_ASSIGN | IN_MATCH(룸접속) | 룸접속 실패 → QUEUE_RECOVERY |
| IN_MATCH | S2C_MATCH_ENDED | RESULT | 재접속 실패 시 이탈 처리 |
| RESULT | C2S_REMATCH_VOTE | READY_CHECK 또는 LOBBY | 투표 실패/거절 시 LOBBY |

---

## 4) 인증/온보딩 이벤트

## 4-1. C2S_BOOT_READY
```json
{
  "appVersion": "0.2.0",
  "platform": "web",
  "locale": "ko-KR",
  "regionCandidates": ["KR", "JP", "SG"]
}
```

응답:
- `S2C_BOOT_ACK`
- `S2C_FORCE_UPDATE` (필드: `minVersion`, `storeUrl`)

## 4-2. C2S_AUTH_LOGIN
```json
{
  "provider": "google",
  "idToken": "..."
}
```

응답:
- `S2C_AUTH_OK`
```json
{
  "accountId": "acc_123",
  "sessionId": "sess_456",
  "isFirstUser": true,
  "displayName": "형진님"
}
```
- `S2C_AUTH_FAIL` (`errorCode`, `message`)

## 4-3. C2S_AUTH_GUEST
```json
{
  "deviceId": "web_local_guid"
}
```

## 4-4. C2S_ONBOARDING_COMPLETE
```json
{
  "nickname": "SenseNaming",
  "tutorialDone": true,
  "starterHeroIds": ["iris_wolf", "milky_rabbit"],
  "acceptedTermsVersion": "2026-02"
}
```

---

## 5) 파티/방 이벤트

## 5-1. 파티 관리
- `C2S_PARTY_CREATE`
- `C2S_PARTY_INVITE` (`targetAccountId`)
- `C2S_PARTY_ACCEPT`
- `C2S_PARTY_LEAVE`
- `C2S_PARTY_KICK` (리더만)
- `C2S_PARTY_READY_TOGGLE`

서버 브로드캐스트:
- `S2C_PARTY_STATE`
```json
{
  "partyId": "party_1",
  "leaderId": "acc_a",
  "members": [
    {"accountId":"acc_a","ready":true},
    {"accountId":"acc_b","ready":false}
  ],
  "modeId": "3v3_normal"
}
```

## 5-2. 커스텀 방(옵션)
- `C2S_CUSTOM_ROOM_CREATE`
- `C2S_CUSTOM_ROOM_JOIN`
- `C2S_CUSTOM_ROOM_START`
- `C2S_CUSTOM_ROOM_UPDATE_SETTINGS`

필수 설정 payload:
```json
{
  "modeId": "3v3_normal",
  "teamSize": 3,
  "allowSpectator": false,
  "allowDuplicateHero": false,
  "private": true,
  "password": "optional"
}
```

---

## 6) 매칭/큐 이벤트

## 6-1. C2S_QUEUE_JOIN
```json
{
  "modeId": "3v3_rank",
  "regionPreference": "KR",
  "partyId": "party_1",
  "inputDevice": "kbm"
}
```

응답:
- `S2C_QUEUE_JOINED`
```json
{
  "queueTicketId": "qt_123",
  "modeId": "3v3_rank",
  "joinedAt": 1760781245123
}
```

## 6-2. 큐 상태 푸시
- `S2C_QUEUE_STATUS`
```json
{
  "queueTicketId": "qt_123",
  "elapsedSec": 37,
  "estimatedWaitSec": 55,
  "searchRange": {
    "maxPingMs": 110,
    "srRange": 120
  }
}
```

## 6-3. C2S_QUEUE_CANCEL
```json
{
  "queueTicketId": "qt_123",
  "reason": "user_cancel"
}
```

응답: `S2C_QUEUE_CANCELLED`

---

## 7) Match Found / Ready Check 계약

## 7-1. S2C_MATCH_FOUND
```json
{
  "matchCandidateId": "mc_777",
  "modeId": "3v3_rank",
  "acceptDeadlineSec": 10,
  "mapPool": ["NJD_CR_01", "HMY_SZ_01"]
}
```

## 7-2. C2S_MATCH_ACCEPT
```json
{
  "matchCandidateId": "mc_777",
  "accept": true
}
```

## 7-3. S2C_READY_CHECK_RESULT
```json
{
  "matchCandidateId": "mc_777",
  "status": "ALL_ACCEPTED",
  "acceptedCount": 6,
  "requiredCount": 6
}
```

가능 status:
- `ALL_ACCEPTED`
- `FAILED_TIMEOUT`
- `FAILED_DECLINED`

실패 시:
- 수락한 인원: 큐 복귀
- 거절/무응답 인원: `S2C_QUEUE_PENALTY_APPLIED`

---

## 8) 드래프트 이벤트 계약

## 8-1. S2C_DRAFT_START
```json
{
  "matchId": "m_1001",
  "modeId": "3v3_rank",
  "draftType": "TURN_BAN_PICK",
  "turnOrder": ["teamA_ban", "teamB_ban", "teamA_pick", "teamB_pick"],
  "timePerTurnSec": 20
}
```

## 8-2. C2S_DRAFT_ACTION
```json
{
  "matchId": "m_1001",
  "actionType": "PICK",
  "heroId": "iris_wolf",
  "turnSeq": 3
}
```

`actionType`:
- `HOVER`
- `BAN`
- `PICK`
- `LOCK`

## 8-3. S2C_DRAFT_STATE
```json
{
  "matchId": "m_1001",
  "turnSeq": 3,
  "remainingSec": 12,
  "teamA": {
    "bans": ["rockhorn_rhino"],
    "picks": ["iris_wolf"],
    "locked": ["acc_a"]
  },
  "teamB": {
    "bans": ["lumifox"],
    "picks": [],
    "locked": []
  }
}
```

## 8-4. 타임아웃
- `S2C_DRAFT_TIMEOUT_AUTOPICK`
```json
{
  "matchId": "m_1001",
  "accountId": "acc_b",
  "pickedHeroId": "milky_rabbit",
  "reason": "TURN_TIMEOUT"
}
```

---

## 9) 매치 할당/룸 접속 계약

## 9-1. S2C_MATCH_ASSIGN
```json
{
  "matchId": "m_1001",
  "room": {
    "endpoint": "wss://kr-room-12.wildpaw.gg:7001",
    "roomToken": "jwt_or_signed_token",
    "region": "KR"
  },
  "mapId": "NJD_CR_01",
  "modeId": "3v3_rank",
  "teamInfo": {
    "teamId": 1,
    "slot": 2
  }
}
```

## 9-2. 룸 접속 이후
클라 처리:
1. room endpoint 접속
2. `HelloPayload(room_token, client_version)` 전송
3. `WelcomePayload` 수신
4. `SnapshotPayload(Base)` 수신 후 인게임 시작

실패 처리:
- 1차 실패: 동일 room 재시도 1회
- 2차 실패: `S2C_MATCH_ASSIGN_RETRY` 요청
- 재시도 실패: `S2C_QUEUE_RECOVERY`

---

## 10) 인게임/종료/리매치 계약

## 10-1. 인게임 제어 이벤트
- `S2C_MATCH_PAUSE_NOTICE` (서버 유지보수/긴급)
- `S2C_RECONNECT_WINDOW` (복귀 허용 시간 알림)

## 10-2. 경기 종료
- `S2C_MATCH_ENDED`
```json
{
  "matchId": "m_1001",
  "result": "WIN",
  "score": {"teamA": 12, "teamB": 9},
  "rewards": {
    "rpDelta": 24,
    "xp": 380,
    "currency": {"pawCoin": 130}
  }
}
```

## 10-3. 리매치
- `C2S_REMATCH_VOTE`
- `S2C_REMATCH_STATE`
- `S2C_REMATCH_START` 또는 `S2C_REMATCH_CANCELLED`

---

## 11) 에러 코드/복구 규약

| code | 의미 | 클라 기본 동작 |
|---|---|---|
| AUTH_INVALID_TOKEN | 인증 토큰 무효 | AUTH 화면으로 복귀 |
| QUEUE_INVALID_MODE | 잘못된 모드 | 로비로 복귀 + 토스트 |
| QUEUE_PENALTY_ACTIVE | 큐 제한 중 | 남은 시간 표시 |
| READY_TIMEOUT | 수락 시간 초과 | 큐 페널티 고지 |
| DRAFT_INVALID_TURN | 턴 위반 액션 | 현재 턴 UI 강조 |
| DRAFT_HERO_UNAVAILABLE | 선택 불가 히어로 | 그리드 잠금 표시 |
| MATCH_ASSIGN_EXPIRED | 룸 토큰 만료 | 재할당 요청 |
| ROOM_CONNECT_FAIL | 룸 연결 실패 | 재시도 -> 큐 복구 |
| RECONNECT_WINDOW_EXPIRED | 재접속 창 만료 | 결과/페널티 처리 |

---

## 12) 멱등성/중복 방지 규칙

1. `eventId` 중복 수신 시 서버는 동일 응답 재사용
2. `requestId`는 클라이언트 단위 단조 증가 권장
3. 드래프트 액션은 `(matchId, turnSeq, accountId)`를 unique key로 처리
4. 매치 수락은 `matchCandidateId` 기준 1회만 유효

---

## 13) 타임아웃/재시도 정책

| 구간 | 제한시간 | 재시도 |
|---|---:|---:|
| Match Found 수락 | 10초 | 없음(재큐) |
| Draft 턴 | 20초(모드별 가변) | 없음(오토픽) |
| Match Assign 후 룸 접속 | 8초 | 1회 |
| 인게임 재접속 | 20초 | 지속 시도 |
| Queue API | 3초 | 지수 백오프 3회 |

---

## 14) 보안/치트 대응 규칙

- 모든 C2S는 인증 세션 필요(게스트 포함)
- `roomToken`은 단기 만료(권장 30~60초)
- 드래프트 픽/밴은 서버 턴 검증 필수
- 클라 전송의 전투 결과값(데미지/킬)은 무시

---

## 15) 텔레메트리 매핑

필수 로그 이벤트:
- `queue_joined`, `queue_cancelled`
- `match_found_shown`, `match_accepted`, `ready_check_failed`
- `draft_started`, `draft_pick`, `draft_autopick`
- `match_assigned`, `room_connect_success/fail`
- `reconnect_attempt/success/fail`

각 이벤트 공통 속성:
- `accountId`, `partyId`, `matchId`, `modeId`, `region`, `buildVersion`

---

## 16) 구현 우선순위

P0:
- AUTH/QUEUE/MATCH_FOUND/READY_CHECK/MATCH_ASSIGN/RESULT

P1:
- DRAFT full state sync + 오토픽

P2:
- 커스텀 룸 + 리매치 최적화 + 세부 페널티 정책

---

## 17) 결론
이 계약서의 핵심은 "이벤트 이름 나열"이 아니라,
**상태 전이 + 실패 복구 + 멱등성**까지 포함한 운영 가능한 프로토콜을 고정하는 것이다.

다음 액션:
1. Gateway control API 구현과 본 문서 1:1 매핑
2. 클라이언트 상태머신(AppFlowState)와 requestId/eventId 적용
3. QA가 이벤트 리플레이로 흐름을 검증할 수 있도록 로그 표준화
