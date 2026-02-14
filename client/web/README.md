# client/web netcode scaffold

Three.js 클라이언트에 붙일 netcode 모듈 스캐폴드입니다.

## 포함 모듈
- `types.ts`: snapshot/input 타입
- `prediction.ts`: 로컬 예측/복구
- `interpolation.ts`: 원격 플레이어 보간 버퍼
- `netClient.ts`: WebSocket 기반 실시간 클라이언트 래퍼
  - `seq/ack/ackBits` 메타 자동 부여
  - 서버 수신 패킷의 `seq`를 추적해 다음 C2S 메시지에 ack 반영

## 통합 순서 (M1)
1. 게임 입력 시스템에서 `InputFrame` 생성
2. `RealtimeClient.sendInput()`으로 전송
3. snapshot 수신 시
   - 내 플레이어: `reconcile()`
   - 타 플레이어: `SnapshotInterpolationBuffer.sample()` 결과 렌더

> 현재는 JSON envelope 기반이며, 추후 binary protocol로 교체 예정.
