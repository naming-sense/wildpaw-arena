#pragma once

#include <cstddef>
#include <cstdint>
#include <deque>
#include <span>
#include <string>

namespace wildpaw::room {

struct AckState {
  std::uint32_t remoteSeq{0};
  std::uint32_t ack{0};
  std::uint32_t ackBits{0};
};

class RoomSession {
 public:
  explicit RoomSession(std::uint32_t playerId);

  void onClientPacket(std::uint32_t sequence);
  [[nodiscard]] bool hasReceived(std::uint32_t sequence) const;

  // TODO: 실제 구현에서는 binary writer로 교체.
  [[nodiscard]] std::string encodeReliableEnvelope(
      std::span<const std::byte> payload,
      std::uint32_t serverTick) const;

  [[nodiscard]] std::uint32_t playerId() const { return playerId_; }
  [[nodiscard]] const AckState& ackState() const { return ackState_; }

 private:
  void markReceived(std::uint32_t sequence);

  std::uint32_t playerId_{0};
  AckState ackState_{};
  std::deque<std::uint32_t> receiveWindow_;
};

}  // namespace wildpaw::room
