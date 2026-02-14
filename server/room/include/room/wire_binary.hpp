#pragma once

#include <cstdint>
#include <span>
#include <vector>

#include "room/envelope_meta.hpp"
#include "room/snapshot_builder.hpp"

namespace wildpaw::room::wire {

enum class BinaryMessageType : std::uint16_t {
  SnapshotDelta = 1,
};

constexpr std::uint32_t kBinaryMagic = 0x57445031;  // "WDP1"
constexpr std::uint16_t kBinaryVersion = 1;

std::vector<std::uint8_t> encodeSnapshotDeltaBinary(
    const SnapshotDelta& delta,
    std::uint64_t serverTimeMs,
    std::span<const PlayerState> visiblePlayers,
    const EnvelopeMeta& meta);

}  // namespace wildpaw::room::wire
