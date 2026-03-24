# 다마고치 LLM 서버 아키텍처 / 요구사항 / 구현계획

## 0) 문서 목적
`tamagotchi_llm_기획요약.md`를 기반으로, 실제 개발 가능한 수준의 서버 설계 초안을 정의한다.

---

## 1) 아키텍처 개요

## 1.1 상위 구조
```text
[Unreal Client (Mobile)]
   └─ WebSocket
        ↓
[Realtime Gateway]
   ├─ Session Manager
   ├─ Event Router
   └─ Rate Limit/Auth
        ↓
[Interaction Orchestrator]
   ├─ Fast Response Engine (1차 응답)
   ├─ Deep LLM Engine (2차 응답)
   ├─ Intent & Emotion Inference
   ├─ Action Planner (리액션/행동 결정)
   └─ Safety Filter
        ↓
[State & Memory Layer]
   ├─ Redis (세션/저지연 상태)
   ├─ Postgres (유저/캐릭터 영속 데이터)
   └─ Vector DB (장기 대화/개인화 검색)
        ↓
[Media/Voice Layer (옵션)]
   ├─ STT (음성→텍스트)
   ├─ TTS (캐릭터 음성)
   └─ Voice Style Profile
```

## 1.2 2단계 응답 설계 (핵심)
1. 이벤트 수신 즉시 `ack` + 짧은 반응 생성 (Fast Engine)
2. 동시에 Deep LLM이 맥락 포함 고품질 응답 생성
3. 준비되면 `response_update`로 후속 대사/행동/감정 상태 갱신

> 목표: 사용자는 "바로 반응한다"고 느끼고, 뒤이어 "더 똑똑한 답"을 받는다.

## 1.3 언리얼 연동 포인트
- 입력 이벤트: `text_input`, `voice_input`, `touch_event`, `context_event`
- 출력 이벤트: `speak`, `animation`, `emotion_update`, `action_suggestion`, `state_sync`
- 클라이언트는 **즉시 반응 가능한 로컬 애니메이션 fallback**을 보유

---

## 2) 요구사항

## 2.1 기능 요구사항 (FR)
- FR-01: WebSocket 기반 양방향 실시간 통신
- FR-02: 텍스트 대화 처리
- FR-03: 터치 이벤트 처리 및 리액션 결정
- FR-04: 1차(저지연) + 2차(고품질) 응답 파이프라인
- FR-05: 캐릭터 상태값 관리(배고픔/기분/친밀도/에너지)
- FR-06: 상태값에 따라 발화/행동 스타일 변화
- FR-07: 사용자 개인화 메모리 저장/조회
- FR-08: 음성 입력(STT), 음성 출력(TTS) 확장 가능 구조
- FR-09: 관리자용 로그/대시보드(지연, 오류, 토큰량)

## 2.2 비기능 요구사항 (NFR)
- NFR-01: 1차 응답 시작 지연 P95 < 800ms
- NFR-02: 2차 응답 완료 P95 < 4s (일반 대화)
- NFR-03: WebSocket 연결 안정성 99.9%+
- NFR-04: 수평 확장 가능(동시 접속 증가 대응)
- NFR-05: 관측성(Tracing, Metrics, Structured Logging)
- NFR-06: 개인정보 최소 수집 + 암호화 저장

## 2.3 안전/윤리 요구사항
- “생각 읽기”는 실제 독심이 아니라 **발화/행동/상황 기반 의도 추론**으로 정의
- 사용자 음성/행동 개인화는 **명시적 동의(opt-in)** 기반
- 민감 정보/미성년자 정책/유해 발화 필터 적용

---

## 3) 이벤트/프로토콜 초안

## 3.1 클라이언트 → 서버
```json
{
  "type": "touch_event",
  "session_id": "s_123",
  "user_id": "u_001",
  "payload": {
    "target": "head",
    "gesture": "tap",
    "pressure": 0.4,
    "timestamp": 1710000000
  }
}
```

## 3.2 서버 → 클라이언트 (1차 즉시)
```json
{
  "type": "reaction_quick",
  "payload": {
    "animation": "blink_happy",
    "emotion": "curious",
    "text": "어? 간지럽다!"
  }
}
```

## 3.3 서버 → 클라이언트 (2차 고도화)
```json
{
  "type": "reaction_refined",
  "payload": {
    "text": "지금 기분이 좋아졌어. 조금 더 놀아줄래?",
    "emotion": "affection",
    "action_suggestion": "pet_again",
    "state_patch": { "bond": +2, "mood": +1 }
  }
}
```

---

## 4) 구현 계획 (로드맵)

## Phase 1 — MVP (2~4주)
- WebSocket Gateway + 세션 관리
- 텍스트 입력/출력 + 터치 이벤트 처리
- Fast Engine(룰+소형 모델) / Deep Engine(주력 LLM) 분리
- Redis 기반 상태 관리 + Postgres 영속화
- 기본 캐릭터 상태 로직
- 최소 모니터링(응답속도/오류)

## Phase 2 — 고도화 (3~6주)
- Intent/Emotion 추론 강화
- 개인화 메모리(Vector DB) + 프롬프트 최적화
- 액션 플래너 정교화(상황별 애니메이션 선택)
- 스트리밍 응답/중간 업데이트 최적화

## Phase 3 — 음성/캐릭터성 강화 (4주+)
- STT/TTS 파이프라인 통합
- 사용자 말투/속도 반영(옵션)
- 장기 성장 시스템(성격 진화, 루틴, 이벤트)
- A/B 테스트 기반 UX 개선

---

## 5) 추천 기술 스택
- **Gateway/Orchestrator**: Python(FastAPI/WebSocket) 또는 Node.js(NestJS + ws)
- **Queue/Event**: Redis Streams (초기) → 필요 시 Kafka
- **DB**: Postgres + Redis + Vector DB(pgvector/Weaviate 등)
- **LLM 호출**: 모델 라우팅(소형/대형) + timeout/fallback
- **Observability**: OpenTelemetry + Prometheus + Grafana
- **배포**: Docker + K8s(트래픽 증가 시)

---

## 6) 핵심 리스크와 대응
- 리스크: 2차 응답 지연 → 대응: timeout, 요약 응답 fallback, 캐시
- 리스크: 리액션 부자연스러움 → 대응: 룰 기반 최소 품질선 + LLM 보정
- 리스크: 비용 증가 → 대응: 소형 모델 우선, 고급 모델 조건부 호출
- 리스크: 개인화 정확도 낮음 → 대응: 피드백 버튼(좋아요/별로)로 온라인 튜닝

---

## 7) 바로 시작할 개발 태스크 (우선순위)
1. WebSocket 메시지 스키마 확정 (입출력 이벤트 표준화)
2. Fast/Deep 이중 응답 오케스트레이터 구현
3. 캐릭터 상태 머신(기분/친밀도/에너지) 구현
4. Unreal 샘플 씬에서 터치 이벤트 ↔ 리액션 왕복 테스트
5. 지연 측정 대시보드(ACK 지연, 최종응답 지연) 구축


필요하면 다음 단계로, 위 문서를 기준으로 **실제 코드 베이스 구조(폴더 트리), API 명세(OpenAPI), DB 스키마(SQL)**까지 바로 뽑아드릴 수 있습니다.
