#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>

#include "room/input_buffer.hpp"
#include "room/room_simulation.hpp"
#include "room/snapshot_builder.hpp"

namespace wildpaw::room::wire {

std::optional<std::string> extractEnvelopeType(std::string_view raw);

std::optional<InputFrame> decodeInputEnvelope(std::string_view raw);

std::string encodeWelcome(std::uint32_t playerId,
                          std::uint32_t tickRate,
                          std::uint32_t serverTick);

std::string encodeSnapshotBase(const WorldSnapshot& snapshot,
                               std::uint64_t serverTimeMs);

std::string encodeSnapshotDelta(const SnapshotDelta& delta,
                                std::uint64_t serverTimeMs,
                                std::span<const PlayerState> visiblePlayers);

std::string encodeEvent(std::string_view eventName, std::string_view message);

}  // namespace wildpaw::room::wire
