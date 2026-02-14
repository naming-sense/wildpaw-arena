# client/web netcode scaffold

Three.js 클라이언트에 붙일 netcode 모듈 스캐폴드입니다.

## 포함 모듈
- `types.ts`: snapshot/input 타입
- `prediction.ts`: 로컬 예측/복구
- `interpolation.ts`: 원격 플레이어 보간 버퍼
- `netClient.ts`: FlatBuffers 기반 realtime transport
  - C2S binary envelope 송신 (`HELLO/INPUT/PING`)
  - S2C binary envelope 수신 (`WELCOME/SNAPSHOT/EVENT`)
  - `seq/ack/ackBits` 자동 추적
- `src/netcode/gen/*`: flatc로 생성된 TS 코드

## 의존성 설치
```bash
cd client/web
npm install
```

## 통합 순서 (M1)
1. 게임 입력 시스템에서 `InputFrame` 생성
2. `RealtimeClient.sendInput()`으로 전송
3. snapshot 수신 시
   - 내 플레이어: `reconcile()`
   - 타 플레이어: `SnapshotInterpolationBuffer.sample()` 결과 렌더
