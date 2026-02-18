# server/gateway (Control Channel)

`20_게임플로우_API_이벤트_서버계약서.md` 기반의 **Gateway Control Channel** 실행 스캐폴드입니다.

- 프로토콜: WebSocket JSON Envelope
- 역할: 인증/온보딩/파티/큐/레디체크/드래프트/매치할당/리매치
- 전투 채널(room realtime)은 별도(`server/room`, FlatBuffers binary)

---

## 1) 실행

```bash
cd server/gateway
npm install
npm run start
```

기본 포트: `7200`

---

## 2) 환경변수

- `CONTROL_PORT` (default: `7200`)
- `MIN_APP_VERSION` (default: `0.2.0`)
- `STORE_URL` (강제 업데이트 링크)
- `READY_CHECK_TIMEOUT_SEC` (default: `10`)
- `DRAFT_TURN_SEC` (default: `20`)
- `MATCH_ASSIGN_CONNECT_TIMEOUT_SEC` (default: `8`)
- `RECONNECT_WINDOW_SEC` (default: `20`)
- `QUEUE_PENALTY_SEC` (default: `30`)
- `SIM_MATCH_DURATION_SEC` (default: `45`)
- `ROOM_ENDPOINT` (default: `ws://127.0.0.1:7001`)
- `ROOM_REGION` (default: `KR`)
- `ROOM_TOKEN_TTL_SEC` (default: `45`)

예시:

```bash
CONTROL_PORT=7200 ROOM_ENDPOINT=ws://127.0.0.1:7001 npm run start
```

---

## 3) 구현 범위 (계약서 매핑)

### P0 흐름
- `C2S_BOOT_READY` → `S2C_BOOT_ACK` / `S2C_FORCE_UPDATE`
- `C2S_AUTH_LOGIN` / `C2S_AUTH_GUEST` → `S2C_AUTH_OK` / `S2C_AUTH_FAIL`
- `C2S_ONBOARDING_COMPLETE` → `S2C_ONBOARDING_SAVED`
- `C2S_QUEUE_JOIN` / `C2S_QUEUE_CANCEL`
  - `S2C_QUEUE_JOINED`, `S2C_QUEUE_STATUS`, `S2C_QUEUE_CANCELLED`
- `S2C_MATCH_FOUND` / `C2S_MATCH_ACCEPT`
  - `S2C_READY_CHECK_RESULT`
  - 실패 시 `S2C_QUEUE_PENALTY_APPLIED`
- Draft
  - `S2C_DRAFT_START`, `S2C_DRAFT_STATE`
  - `C2S_DRAFT_ACTION`
  - 턴 타임아웃 시 `S2C_DRAFT_TIMEOUT_AUTOPICK`
- Match Assign
  - `S2C_MATCH_ASSIGN`
  - 룸 접속 실패 보고(선택): `C2S_ROOM_CONNECT_RESULT`
  - 재시도/복구: `S2C_MATCH_ASSIGN_RETRY`, `S2C_QUEUE_RECOVERY`
- Match End/Rematch
  - `S2C_MATCH_ENDED`
  - `C2S_REMATCH_VOTE`, `S2C_REMATCH_STATE`, `S2C_REMATCH_START`/`S2C_REMATCH_CANCELLED`

### Party/Custom Room
- Party: create/invite/accept/leave/kick/ready toggle + `S2C_PARTY_STATE`
- Custom room: create/join/update/start

---

## 4) 멱등성/중복 방지

- 동일 `eventId` 재수신 시 서버는 캐시된 동일 응답을 재전송
- Ready check 수락은 `matchCandidateId` 기준 1회 유효
- Draft action은 `(matchId, turnSeq, accountId)` unique key로 dedup

---

## 5) 스모크 테스트

```bash
cd server/gateway
npm install

# gateway가 켜진 상태에서 실행
npm run smoke
```

기본 시나리오:
- 6명(3v3) 접속
- boot/auth/onboarding/queue
- match found + all accept
- draft 4턴 처리
- match assign 수신
- room connect OK 보고

출력 JSON에서 `matchAssignCount`, `errors`를 확인합니다.
