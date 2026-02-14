# client/web netcode scaffold

Three.js 클라이언트에 붙일 netcode 모듈 스캐폴드입니다.

## 포함 모듈
- `types.ts`: snapshot/input 타입
- `prediction.ts`: 로컬 예측/복구
- `interpolation.ts`: 원격 플레이어 보간 버퍼
- `netClient.ts`: WebSocket 실시간 클라이언트
  - JSON envelope 송신 시 `seq/ack/ackBits` 자동 부여
  - 서버의 JSON/바이너리 수신 모두 처리
  - binary `S2C_SNAPSHOT_DELTA` 디코드 지원

## 통합 순서 (M1)
1. 게임 입력 시스템에서 `InputFrame` 생성
2. `RealtimeClient.sendInput()`으로 전송
3. snapshot 수신 시
   - 내 플레이어: `reconcile()`
   - 타 플레이어: `SnapshotInterpolationBuffer.sample()` 결과 렌더

> 현재는 하이브리드(JSON + binary delta) 단계이며, 추후 full binary protocol로 전환 예정.
