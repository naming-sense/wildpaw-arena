#include "room/room_session.hpp"

#include <algorithm>

namespace wildpaw::room {

RoomSession::RoomSession(std::uint32_t playerId) : playerId_(playerId) {}

void RoomSession::onClientPacket(std::uint32_t sequence,
                                 std::uint32_t clientAck,
                                 std::uint32_t clientAckBits) {
  if (sequence != 0) {
    markReceivedClientSequence(sequence);

    if (sequence > outboundAckState_.remoteSeq) {
      outboundAckState_.remoteSeq = sequence;
    }

    if (sequence > outboundAckState_.ack) {
      outboundAckState_.ack = sequence;
      recomputeOutboundAckBits();
    }
  }

  lastClientAck_ = clientAck;
  lastClientAckBits_ = clientAckBits;
}

std::uint32_t RoomSession::nextServerSequence() {
  return ++serverSequence_;
}

bool RoomSession::wasServerPacketAcked(std::uint32_t serverSequence) const {
  if (serverSequence == 0) {
    return false;
  }

  if (serverSequence == lastClientAck_) {
    return true;
  }

  if (serverSequence > lastClientAck_) {
    return false;
  }

  const std::uint32_t diff = lastClientAck_ - serverSequence - 1;
  if (diff >= 32) {
    return false;
  }

  return ((lastClientAckBits_ >> diff) & 1u) != 0;
}

bool RoomSession::hasReceivedClientSequence(std::uint32_t sequence) const {
  return std::find(receivedClientSeqWindow_.begin(), receivedClientSeqWindow_.end(),
                   sequence) != receivedClientSeqWindow_.end();
}

void RoomSession::markReceivedClientSequence(std::uint32_t sequence) {
  if (hasReceivedClientSequence(sequence)) {
    return;
  }

  receivedClientSeqWindow_.push_back(sequence);
  while (receivedClientSeqWindow_.size() > 128) {
    receivedClientSeqWindow_.pop_front();
  }
}

void RoomSession::recomputeOutboundAckBits() {
  outboundAckState_.ackBits = 0;
  const std::uint32_t ack = outboundAckState_.ack;

  if (ack == 0) {
    return;
  }

  for (const auto sequence : receivedClientSeqWindow_) {
    if (sequence >= ack) {
      continue;
    }

    const std::uint32_t diff = ack - sequence - 1;
    if (diff < 32) {
      outboundAckState_.ackBits |= (1u << diff);
    }
  }
}

}  // namespace wildpaw::room
