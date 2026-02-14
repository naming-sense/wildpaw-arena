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

struct EnvelopeMeta {
  std::uint32_t seq{0};
  std::uint32_t ack{0};
  std::uint32_t ackBits{0};
};

std::optional<std::string> extractEnvelopeType(std::string_view raw);

std::optional<EnvelopeMeta> decodeEnvelopeMeta(std::string_view raw);
std::optional<InputFrame> decodeInputEnvelope(std::string_view raw);

std::string encodeWelcome(std::uint32_t playerId,
                          std::uint32_t tickRate,
                          std::uint32_t serverTick,
                          const EnvelopeMeta& meta);

std::string encodeSnapshotBase(const WorldSnapshot& snapshot,
                               std::uint64_t serverTimeMs,
                               const EnvelopeMeta& meta);

std::string encodeSnapshotDelta(const SnapshotDelta& delta,
                                std::uint64_t serverTimeMs,
                                std::span<const PlayerState> visiblePlayers,
                                const EnvelopeMeta& meta);

std::string encodeEvent(std::string_view eventName,
                        std::string_view message,
                        const EnvelopeMeta& meta);

}  // namespace wildpaw::room::wire
