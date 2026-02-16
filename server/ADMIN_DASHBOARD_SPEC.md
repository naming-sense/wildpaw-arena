# Wildpaw Admin Dashboard 요구사항 (M1)

> 목적: 현재 구현된 `server/room` 프로세스(단일 룸 서버)의 **상태/세션/이상징후**를
> 브라우저에서 확인하고, 최소한의 운영 액션(강제 종료/룰 리로드 등)을 수행할 수 있는 관리자 페이지.
>
> 구현 원칙: “문서로 끝내지 말고 **바로 실행 가능한 형태**로 만든다.”

---

## 1) 배경 / 현재 구조

- 현재 repo는 **룸 서버 1프로세스 = 1룸** 모델이다.
- Room 서버는 WebSocket(게임 트래픽) + HTTP(`/metrics`)를 동시에 제공한다.
- 서버는 FlatBuffers Envelope 기반이며 `seq/ack/ackBits`로 retransmit을 수행한다.

이 요구사항 문서는 **단일 room 프로세스 내장형 admin**을 1차 목표로 한다.
(향후 다중 room 프로세스/다중 호스트를 모니터링하는 “집계 Admin”은 별도 M2로 분리)

---

## 2) 사용자 시나리오

운영자/개발자가 아래 질문에 즉시 답할 수 있어야 한다.

1. 지금 동접이 몇 명인가?
2. 지금 “방(룸)”이 몇 개인가?
   - M1: 프로세스 단일 룸이므로 rooms=1을 표시
   - M2: 여러 룸 프로세스를 집계하여 rooms=N 표시
3. 누가 접속해 있는가? (playerId, 연결 시간, 마지막 패킷 시각)
4. 접속한 사람의 IP/포트 정보는 무엇인가?
5. 비정상 패킷을 보내는 사람은 없는가?
   - invalid FlatBuffers envelope
   - text frame(C2S text)
   - unsupported message type
   - 과도한 입력/패킷 rate
   - profile invalid 요청 반복 등
6. 서버 틱이 정상인가? (tick overrun, last tick duration)
7. retransmit이 과도하게 발생하는가? (sent/dropped/inflight)
8. 룰(combat_rules.json)을 바꿨을 때 서버가 반영했는가? (hot reload)

---

## 3) 기능 요구사항 (Functional)

### 3-1. Overview(대시보드 요약)
- 현재 시각(now)
- 서버 정보
  - ws port, metrics/admin port
  - tickRate, currentTick
  - rulesPath, defaultProfile
  - uptime(선택)
- 동접
  - active sessions count
- tick 건강
  - last tick duration(ms)
  - tick overrun total
- 입력 큐
  - pending input queue depth / peak
  - dropped input frames total
- 전송/신뢰
  - reliable inflight packets
  - retransmit sent/dropped total
- snapshot
  - snapshot base/delta sent total
- 이벤트
  - combat/projectile event sent total
  - combat/projectile event filtered total
- 룰 리로드
  - rule_reload_success_total / failure_total

### 3-2. Sessions(접속자 목록)
세션별로 아래 필드를 표로 제공.

- 식별
  - playerId
  - remote ip:port
  - connectedAt / lastSeenAt
- 트래픽
  - bytesIn/bytesOut
  - binaryFramesIn
  - textFramesIn
- 이상징후 카운터
  - invalidEnvelopeTotal
  - unsupportedMessageTotal
  - invalidProfileSelectTotal
  - rateLimitedTotal(옵션)
- 네트워크 신뢰 상태
  - reliableInFlight
  - lastClientAck/ackBits(선택)

정렬/필터:
- invalidEnvelopeTotal DESC
- 최근 lastSeen 기준
- remote ip 검색(선택)

### 3-3. Violations(이상 이벤트 로그)
서버가 탐지한 “이상 징후”를 최근 N건(예: 200) 링버퍼로 유지하고 UI에 노출.

예시 이벤트 타입:
- `invalid_envelope`
- `unsupported_message_type`
- `c2s_text_frame`
- `profile_invalid`
- `rate_limit`
- `message_too_big` (WS 레벨)

필드:
- timeMs
- playerId
- remote ip
- type
- detail

### 3-4. Admin Actions(운영 액션)
M1에서 최소 제공:
- 특정 playerId 세션 강제 종료(disconnect)
- 룰 파일 수동 reload(선택)

M2 후보(요구사항만 명시):
- IP ban/allowlist
- 룸 프로세스 restart(오케스트레이션 연동)
- live config(rate limit, thresholds) 수정

---

## 4) 보안/프라이버시 요구사항

- 이 페이지는 IP 등 민감 정보가 포함되므로 **Admin Token**으로 보호한다.
- 권장:
  - 환경변수 `WILDPAW_ADMIN_TOKEN`이 설정되면 `/admin/*` 및 `/admin/api/*`는 토큰 필요
  - 토큰 미설정이면 로컬 개발 편의상 allow(단, 문서에 위험성 명시)
- `/metrics`는 기본적으로 공개(프로메테우스 scrape 편의). 필요 시 별도 토큰 정책 확장.

---

## 5) API 요구사항 (내장 HTTP)

> 모든 응답은 기본적으로 `application/json` (HTML/JS 제외)

### 5-1. Public
- `GET /metrics`

### 5-2. Admin UI
- `GET /admin/` (HTML)

### 5-3. Admin APIs
- `GET /admin/api/status`
- `GET /admin/api/sessions`
- `GET /admin/api/violations`
- `POST /admin/api/sessions/{playerId}/disconnect`
- `POST /admin/api/rules/reload` (선택)

Auth:
- header `x-admin-token: <token>` 또는 query `?token=<token>`

---

## 6) 구현 계획 (개발 항목)

### Phase A (이번 커밋에서 구현)
- Room 서버에 admin/metrics HTTP 라우팅 추가
- 상태/세션/이상 로그 JSON endpoint 구현
- static admin page(HTML+JS) 제공
- 세션에 remote ip 저장 + 카운터(invalid/text/unsupported 등) 누적
- disconnect endpoint 구현

### Phase B (후속)
- rate limit 정책(드랍/킥), 임계치 설정
- ban list(메모리) + persistence
- 멀티 룸/멀티 호스트 집계 Admin(별도 프로세스)

---

## 7) Definition of Done (M1)

- [ ] 브라우저에서 `/admin/` 접속 시 overview + sessions + violations가 표시된다.
- [ ] 동접(active sessions)이 실시간으로 갱신된다.
- [ ] 세션 목록에서 remote ip:port를 확인 가능하다.
- [ ] invalid envelope 등을 발생시키면 violations에 기록된다.
- [ ] 특정 playerId를 강제 종료할 수 있다.
- [ ] 문서(`SERVER_SPEC.md`, `README`)와 실행 방법이 동기화되어 있다.
