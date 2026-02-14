#pragma once

#include <cstdint>
#include <deque>

namespace wildpaw::room {

// 서버가 outbound 패킷에 실어 보낼 ack 상태
// (서버가 수신한 client seq 기준)
struct AckState {
  std::uint32_t remoteSeq{0};
  std::uint32_t ack{0};
  std::uint32_t ackBits{0};
};

class RoomSession {
 public:
  explicit RoomSession(std::uint32_t playerId);

  // 클라이언트에서 온 envelope 메타 반영
  void onClientPacket(std::uint32_t sequence,
                      std::uint32_t clientAck,
                      std::uint32_t clientAckBits);

  // 서버 outbound sequence 발급
  std::uint32_t nextServerSequence();

  // 클라이언트가 서버 패킷을 ack했는지 확인
  [[nodiscard]] bool wasServerPacketAcked(std::uint32_t serverSequence) const;

  [[nodiscard]] bool hasReceivedClientSequence(std::uint32_t sequence) const;

  [[nodiscard]] std::uint32_t playerId() const { return playerId_; }
  [[nodiscard]] const AckState& outboundAckState() const { return outboundAckState_; }
  [[nodiscard]] std::uint32_t lastClientAck() const { return lastClientAck_; }
  [[nodiscard]] std::uint32_t lastClientAckBits() const { return lastClientAckBits_; }

 private:
  void markReceivedClientSequence(std::uint32_t sequence);
  void recomputeOutboundAckBits();

  std::uint32_t playerId_{0};

  AckState outboundAckState_{};
  std::deque<std::uint32_t> receivedClientSeqWindow_;

  std::uint32_t serverSequence_{0};
  std::uint32_t lastClientAck_{0};
  std::uint32_t lastClientAckBits_{0};
};

}  // namespace wildpaw::room
