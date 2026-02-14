#include "room/room_session.hpp"

#include <algorithm>
#include <sstream>

namespace wildpaw::room {

RoomSession::RoomSession(std::uint32_t playerId) : playerId_(playerId) {}

void RoomSession::onClientPacket(std::uint32_t sequence) {
  markReceived(sequence);

  if (sequence > ackState_.remoteSeq) {
    ackState_.remoteSeq = sequence;
    ackState_.ack = sequence;
  }
}

bool RoomSession::hasReceived(std::uint32_t sequence) const {
  return std::find(receiveWindow_.begin(), receiveWindow_.end(), sequence) != receiveWindow_.end();
}

std::string RoomSession::encodeReliableEnvelope(
    std::span<const std::byte> payload,
    std::uint32_t serverTick) const {
  std::ostringstream oss;
  oss << "player=" << playerId_
      << " tick=" << serverTick
      << " ack=" << ackState_.ack
      << " payloadBytes=" << payload.size();
  return oss.str();
}

void RoomSession::markReceived(std::uint32_t sequence) {
  if (hasReceived(sequence)) {
    return;
  }

  receiveWindow_.push_back(sequence);
  while (receiveWindow_.size() > 64) {
    receiveWindow_.pop_front();
  }

  if (ackState_.ack >= sequence) {
    const std::uint32_t diff = ackState_.ack - sequence;
    if (diff < 32) {
      ackState_.ackBits |= (1u << diff);
    }
  }
}

}  // namespace wildpaw::room
