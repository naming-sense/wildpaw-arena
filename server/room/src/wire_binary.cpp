#include "room/wire_binary.hpp"

#include <bit>
#include <cstddef>
#include <cstdint>
#include <span>
#include <type_traits>
#include <vector>

namespace wildpaw::room::wire {
namespace {

template <typename TInt>
void appendLE(std::vector<std::uint8_t>& out, TInt value) {
  static_assert(std::is_integral_v<TInt>, "appendLE requires integral type");

  for (std::size_t i = 0; i < sizeof(TInt); ++i) {
    const std::uint8_t byte = static_cast<std::uint8_t>(
        (static_cast<std::make_unsigned_t<TInt>>(value) >> (i * 8)) & 0xFFu);
    out.push_back(byte);
  }
}

void appendF32(std::vector<std::uint8_t>& out, float value) {
  const std::uint32_t bits = std::bit_cast<std::uint32_t>(value);
  appendLE(out, bits);
}

}  // namespace

std::vector<std::uint8_t> encodeSnapshotDeltaBinary(
    const SnapshotDelta& delta,
    std::uint64_t serverTimeMs,
    std::span<const PlayerState> visiblePlayers,
    const EnvelopeMeta& meta) {
  constexpr std::size_t kHeaderSize = 36;
  constexpr std::size_t kPlayerRecordSize = 28;

  std::vector<std::uint8_t> payload;
  payload.reserve(kHeaderSize + visiblePlayers.size() * kPlayerRecordSize);

  appendLE(payload, kBinaryMagic);                                     // 0
  appendLE(payload, kBinaryVersion);                                   // 4
  appendLE(payload, static_cast<std::uint16_t>(BinaryMessageType::SnapshotDelta));  // 6
  appendLE(payload, meta.seq);                                         // 8
  appendLE(payload, meta.ack);                                         // 12
  appendLE(payload, meta.ackBits);                                     // 16
  appendLE(payload, delta.serverTick);                                 // 20
  appendLE(payload, serverTimeMs);                                     // 24
  appendLE(payload, static_cast<std::uint16_t>(visiblePlayers.size()));  // 32
  appendLE(payload, static_cast<std::uint16_t>(0));                    // 34 reserved

  for (const auto& player : visiblePlayers) {
    appendLE(payload, player.playerId);
    appendF32(payload, player.position.x);
    appendF32(payload, player.position.y);
    appendF32(payload, player.velocity.x);
    appendF32(payload, player.velocity.y);
    appendLE(payload, player.hp);
    appendLE(payload, static_cast<std::uint8_t>(player.alive ? 1 : 0));
    appendLE(payload, static_cast<std::uint8_t>(0));  // reserved
    appendLE(payload, player.lastProcessedInputSeq);
  }

  return payload;
}

}  // namespace wildpaw::room::wire
