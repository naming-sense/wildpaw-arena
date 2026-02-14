# shared/protocol

서버/클라이언트가 공통으로 참조할 프로토콜 정의 위치입니다.

## 현재 포함
- `message_types.hpp`: MVP 메시지 타입 enum
- `packet_header.hpp`: 공통 패킷 헤더(ack/ackBits 포함)

## 다음 단계
1. FlatBuffers 스키마(`*.fbs`)로 페이로드 타입 정의
2. TS 코드젠 파이프라인 추가
3. `S2C_SNAPSHOT_DELTA` 필드 bitpack 규격 확정
