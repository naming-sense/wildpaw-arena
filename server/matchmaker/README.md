# server/matchmaker

Matchmaker 프로세스 스캐폴드 위치입니다.

예정 책임:
- MMR + 핑 + 파티 조건 기반 매칭
- Region 선호/제약 반영
- Room allocator와의 capacity 조율
- queue backlog 기반 scale signal 발행

초기 구현은 room 서버 안정화 후(M3) 착수.
