# Wildpaw Server Scaffold (C++20 + Asio)

## 구성
- `room/`: 실시간 authoritative 룸 서버 스캐폴드
- `gateway/`: 인증/라우팅 계층 (TODO)
- `matchmaker/`: 매칭 계층 (TODO)

## 빌드 (room)
```bash
cd server
cmake -S . -B build
cmake --build build -j
./build/room/wildpaw-room
```

> `asio.hpp`를 찾지 못하면 standalone Asio 설치 또는 include path 설정이 필요합니다.
