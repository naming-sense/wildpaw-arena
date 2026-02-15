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

std::vector<std::uint8_t> finalizeEnvelope(
    flatbuffers::FlatBufferBuilder& builder,
    flatbuffers::Offset<wildpaw::protocol::Envelope> envelope) {
  wildpaw::protocol::FinishEnvelopeBuffer(builder, envelope);
  const auto* ptr = builder.GetBufferPointer();
  const auto size = builder.GetSize();
  return std::vector<std::uint8_t>(ptr, ptr + size);
}

wildpaw::protocol::SkillSlot toProtocolSkillSlot(SkillSlot slot) {
  switch (slot) {
    case SkillSlot::Q:
      return wildpaw::protocol::SkillSlot::Q;
    case SkillSlot::E:
      return wildpaw::protocol::SkillSlot::E;
    case SkillSlot::R:
      return wildpaw::protocol::SkillSlot::R;
    case SkillSlot::None:
    default:
      return wildpaw::protocol::SkillSlot::None;
  }
}

wildpaw::protocol::CombatEventType toProtocolCombatEventType(CombatEventType type) {
  switch (type) {
    case CombatEventType::SkillCast:
      return wildpaw::protocol::CombatEventType::SkillCast;
    case CombatEventType::DamageApplied:
      return wildpaw::protocol::CombatEventType::DamageApplied;
    case CombatEventType::Knockout:
      return wildpaw::protocol::CombatEventType::Knockout;
    case CombatEventType::ShotFired:
    default:
      return wildpaw::protocol::CombatEventType::ShotFired;
  }
}

wildpaw::protocol::ProjectilePhase toProtocolProjectilePhase(ProjectilePhase phase) {
  switch (phase) {
    case ProjectilePhase::Hit:
      return wildpaw::protocol::ProjectilePhase::Hit;
    case ProjectilePhase::Despawn:
      return wildpaw::protocol::ProjectilePhase::Despawn;
    case ProjectilePhase::Spawn:
    default:
      return wildpaw::protocol::ProjectilePhase::Spawn;
  }
}

void fillInputFrameFromProtocol(InputFrame& dst,
                                std::uint32_t inputSeq,
                                int moveX,
                                int moveY,
                                bool fire,
                                float aimRadian,
                                bool skillQ,
                                bool skillE,
                                bool skillR) {
  dst.inputSeq = inputSeq;
  dst.moveX = static_cast<std::int8_t>(std::clamp(moveX, -1, 1));
  dst.moveY = static_cast<std::int8_t>(std::clamp(moveY, -1, 1));
  dst.firing = fire;
  dst.aimRadian = aimRadian;
  dst.skillQ = skillQ;
  dst.skillE = skillE;
  dst.skillR = skillR;
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
      decoded.roomToken =
          hello->room_token() != nullptr ? hello->room_token()->str() : "";
      decoded.clientVersion = hello->client_version() != nullptr
                                  ? hello->client_version()->str()
                                  : "";
      return decoded;
    }

    case wildpaw::protocol::MessagePayload::InputPayload: {
      const auto* input = envelope->payload_as_InputPayload();
      if (input == nullptr) {
        return std::nullopt;
      }

      decoded.type = ClientMessageType::Input;
      fillInputFrameFromProtocol(decoded.input, input->input_seq(), input->move_x(),
                                 input->move_y(), input->fire(),
                                 input->aim_radian(), input->skill_q(),
                                 input->skill_e(), input->skill_r());
      return decoded;
    }

    case wildpaw::protocol::MessagePayload::ActionCommandPayload: {
      const auto* action = envelope->payload_as_ActionCommandPayload();
      if (action == nullptr) {
        return std::nullopt;
      }

      decoded.type = ClientMessageType::ActionCommand;
      fillInputFrameFromProtocol(decoded.input, action->input_seq(),
                                 action->move_x(), action->move_y(),
                                 action->fire(), action->aim_radian(),
                                 action->skill_q(), action->skill_e(),
                                 action->skill_r());
      return decoded;
    }

    case wildpaw::protocol::MessagePayload::SelectProfilePayload: {
      const auto* profile = envelope->payload_as_SelectProfilePayload();
      if (profile == nullptr) {
        return std::nullopt;
      }

      decoded.type = ClientMessageType::SelectProfile;
      decoded.profileId =
          profile->profile_id() != nullptr ? profile->profile_id()->str() : "";
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
        player.lastProcessedInputSeq, player.ammo, player.maxAmmo,
        player.reloading, player.reloadRemainingTicks, player.skillQCooldownTicks,
        player.skillECooldownTicks, player.skillRCooldownTicks,
        toProtocolSkillSlot(player.castingSkill), player.castRemainingTicks);
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

std::vector<std::uint8_t> encodeCombatEventEnvelope(const CombatEvent& event,
                                                    const EnvelopeMeta& meta) {
  flatbuffers::FlatBufferBuilder builder(256);

  const auto payload = wildpaw::protocol::CreateCombatEventPayload(
      builder, toProtocolCombatEventType(event.type), event.sourcePlayerId,
      event.targetPlayerId, toProtocolSkillSlot(event.skillSlot), event.damage,
      event.critical, event.serverTick, event.position.x, event.position.y);

  const auto envelope = wildpaw::protocol::CreateEnvelope(
      builder, meta.seq, meta.ack, meta.ackBits,
      wildpaw::protocol::MessagePayload::CombatEventPayload, payload.Union());

  return finalizeEnvelope(builder, envelope);
}

std::vector<std::uint8_t> encodeProjectileEventEnvelope(
    const ProjectileEvent& event,
    const EnvelopeMeta& meta) {
  flatbuffers::FlatBufferBuilder builder(256);

  const auto payload = wildpaw::protocol::CreateProjectileEventPayload(
      builder, event.projectileId, event.ownerPlayerId, event.targetPlayerId,
      toProtocolProjectilePhase(event.phase), event.serverTick, event.position.x,
      event.position.y, event.velocity.x, event.velocity.y);

  const auto envelope = wildpaw::protocol::CreateEnvelope(
      builder, meta.seq, meta.ack, meta.ackBits,
      wildpaw::protocol::MessagePayload::ProjectileEventPayload,
      payload.Union());

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
