#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <vector>

#include "room/envelope_meta.hpp"
#include "room/input_buffer.hpp"
#include "room/snapshot_builder.hpp"

namespace wildpaw::room::wire {

enum class ClientMessageType {
  Invalid = 0,
  Hello,
  Input,
  ActionCommand,
  SelectProfile,
  Ping,
};

struct DecodedClientEnvelope {
  EnvelopeMeta meta{};
  ClientMessageType type{ClientMessageType::Invalid};

  // Hello payload
  std::string roomToken;
  std::string clientVersion;

  // SelectProfile payload
  std::string profileId;

  // Input/Action payload
  InputFrame input{};
};

std::optional<DecodedClientEnvelope> decodeClientEnvelope(
    std::span<const std::uint8_t> buffer);

std::vector<std::uint8_t> encodeWelcomeEnvelope(std::uint32_t playerId,
                                                std::uint32_t tickRate,
                                                std::uint32_t serverTick,
                                                const EnvelopeMeta& meta);

std::vector<std::uint8_t> encodeSnapshotEnvelope(
    bool isDelta,
    std::uint32_t serverTick,
    std::uint64_t serverTimeMs,
    std::span<const PlayerState> players,
    std::span<const std::uint32_t> removedPlayerIds,
    const EnvelopeMeta& meta);

std::vector<std::uint8_t> encodeCombatEventEnvelope(const CombatEvent& event,
                                                    const EnvelopeMeta& meta);

std::vector<std::uint8_t> encodeProjectileEventEnvelope(
    const ProjectileEvent& event,
    const EnvelopeMeta& meta);

std::vector<std::uint8_t> encodeEventEnvelope(std::string_view eventName,
                                              std::string_view message,
                                              const EnvelopeMeta& meta);

}  // namespace wildpaw::room::wire
