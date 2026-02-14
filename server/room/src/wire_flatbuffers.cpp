#include "room/wire_flatbuffers.hpp"

#include <algorithm>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "wildpaw_protocol_generated.h"

namespace wildpaw::room::wire {
namespace {

std::vector<std::uint8_t> finalizeEnvelope(flatbuffers::FlatBufferBuilder& builder,
                                           flatbuffers::Offset<wildpaw::protocol::Envelope> envelope) {
  wildpaw::protocol::FinishEnvelopeBuffer(builder, envelope);
  const auto* ptr = builder.GetBufferPointer();
  const auto size = builder.GetSize();
  return std::vector<std::uint8_t>(ptr, ptr + size);
}

}  // namespace

std::optional<DecodedClientEnvelope> decodeClientEnvelope(
    std::span<const std::uint8_t> buffer) {
  if (buffer.empty()) {
    return std::nullopt;
  }

  flatbuffers::Verifier verifier(buffer.data(), buffer.size());
  if (!wildpaw::protocol::VerifyEnvelopeBuffer(verifier)) {
    return std::nullopt;
  }

  const auto* envelope = wildpaw::protocol::GetEnvelope(buffer.data());
  if (envelope == nullptr) {
    return std::nullopt;
  }

  DecodedClientEnvelope decoded;
  decoded.meta.seq = envelope->seq();
  decoded.meta.ack = envelope->ack();
  decoded.meta.ackBits = envelope->ack_bits();

  switch (envelope->payload_type()) {
    case wildpaw::protocol::MessagePayload::HelloPayload: {
      const auto* hello = envelope->payload_as_HelloPayload();
      if (hello == nullptr) {
        return std::nullopt;
      }

      decoded.type = ClientMessageType::Hello;
      decoded.roomToken = hello->room_token() != nullptr ? hello->room_token()->str() : "";
      decoded.clientVersion =
          hello->client_version() != nullptr ? hello->client_version()->str() : "";
      return decoded;
    }

    case wildpaw::protocol::MessagePayload::InputPayload: {
      const auto* input = envelope->payload_as_InputPayload();
      if (input == nullptr) {
        return std::nullopt;
      }

      decoded.type = ClientMessageType::Input;
      decoded.input.inputSeq = input->input_seq();
      decoded.input.moveX = static_cast<std::int8_t>(std::clamp<int>(input->move_x(), -1, 1));
      decoded.input.moveY = static_cast<std::int8_t>(std::clamp<int>(input->move_y(), -1, 1));
      decoded.input.firing = input->fire();
      decoded.input.aimRadian = input->aim_radian();
      return decoded;
    }

    case wildpaw::protocol::MessagePayload::PingPayload: {
      decoded.type = ClientMessageType::Ping;
      return decoded;
    }

    default:
      return std::nullopt;
  }
}

std::vector<std::uint8_t> encodeWelcomeEnvelope(std::uint32_t playerId,
                                                std::uint32_t tickRate,
                                                std::uint32_t serverTick,
                                                const EnvelopeMeta& meta) {
  flatbuffers::FlatBufferBuilder builder(256);

  const auto payload =
      wildpaw::protocol::CreateWelcomePayload(builder, playerId, tickRate, serverTick);

  const auto envelope = wildpaw::protocol::CreateEnvelope(
      builder, meta.seq, meta.ack, meta.ackBits,
      wildpaw::protocol::MessagePayload::WelcomePayload, payload.Union());

  return finalizeEnvelope(builder, envelope);
}

std::vector<std::uint8_t> encodeSnapshotEnvelope(
    bool isDelta,
    std::uint32_t serverTick,
    std::uint64_t serverTimeMs,
    std::span<const PlayerState> players,
    const EnvelopeMeta& meta) {
  flatbuffers::FlatBufferBuilder builder(1024);

  std::vector<flatbuffers::Offset<wildpaw::protocol::PlayerState>> playerOffsets;
  playerOffsets.reserve(players.size());

  for (const auto& player : players) {
    const auto position =
        wildpaw::protocol::CreateVec2(builder, player.position.x, player.position.y);
    const auto velocity =
        wildpaw::protocol::CreateVec2(builder, player.velocity.x, player.velocity.y);

    const auto playerState = wildpaw::protocol::CreatePlayerState(
        builder, player.playerId, position, velocity, player.hp, player.alive,
        player.lastProcessedInputSeq);
    playerOffsets.push_back(playerState);
  }

  const auto playersVector = builder.CreateVector(playerOffsets);
  const auto kind = isDelta ? wildpaw::protocol::SnapshotKind::Delta
                            : wildpaw::protocol::SnapshotKind::Base;

  const auto payload = wildpaw::protocol::CreateSnapshotPayload(
      builder, kind, serverTick, serverTimeMs, playersVector);

  const auto envelope = wildpaw::protocol::CreateEnvelope(
      builder, meta.seq, meta.ack, meta.ackBits,
      wildpaw::protocol::MessagePayload::SnapshotPayload, payload.Union());

  return finalizeEnvelope(builder, envelope);
}

std::vector<std::uint8_t> encodeEventEnvelope(std::string_view eventName,
                                              std::string_view message,
                                              const EnvelopeMeta& meta) {
  flatbuffers::FlatBufferBuilder builder(256);

  const auto eventNameOffset = builder.CreateString(eventName.data(), eventName.size());
  const auto messageOffset = builder.CreateString(message.data(), message.size());

  const auto payload =
      wildpaw::protocol::CreateEventPayload(builder, eventNameOffset, messageOffset);

  const auto envelope = wildpaw::protocol::CreateEnvelope(
      builder, meta.seq, meta.ack, meta.ackBits,
      wildpaw::protocol::MessagePayload::EventPayload, payload.Union());

  return finalizeEnvelope(builder, envelope);
}

}  // namespace wildpaw::room::wire
