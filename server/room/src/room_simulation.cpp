#include "room/room_simulation.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace wildpaw::room {

namespace {
constexpr float kPlayerSpeedMps = 4.0f;
constexpr float kWorldBoundary = 50.0f;

constexpr float kShotRange = 12.0f;
constexpr std::uint16_t kShotDamage = 12;
constexpr float kProjectileSpeed = 20.0f;
constexpr std::uint32_t kFireIntervalTicks = 4;  // ~7.5 shots/sec @30Hz

constexpr float kSkillQRange = 14.0f;
constexpr std::uint16_t kSkillQDamage = 20;

constexpr float kSkillRRadius = 10.0f;
constexpr std::uint16_t kSkillRDamage = 28;

float distSq(const Vec2& a, const Vec2& b) {
  const float dx = a.x - b.x;
  const float dy = a.y - b.y;
  return dx * dx + dy * dy;
}

Vec2 directionFromRadian(float radian) {
  return Vec2{.x = std::cos(radian), .y = std::sin(radian)};
}

}  // namespace

RoomSimulation::RoomSimulation(std::uint32_t tickRate)
    : tickRate_(tickRate), inputBuffer_(256) {}

void RoomSimulation::addPlayer(std::uint32_t playerId) {
  PlayerState state;
  state.playerId = playerId;

  // 단순 스폰 분산: 초기 중첩을 피하기 위해 원형 배치.
  const float ringRadius = 3.0f;
  const float angle =
      static_cast<float>((players_.size() % 12) * (3.1415926535 / 6.0));
  state.position = {ringRadius * std::cos(angle), ringRadius * std::sin(angle)};
  state.velocity = {0.0f, 0.0f};

  players_[playerId] = state;
}

void RoomSimulation::removePlayer(std::uint32_t playerId) {
  players_.erase(playerId);
  frameInputs_.erase(playerId);
  previousFrameInputs_.erase(playerId);
  lastFireTick_.erase(playerId);
}

void RoomSimulation::pushInput(std::uint32_t playerId, const InputFrame& frame) {
  inputBuffer_.push(playerId, frame);
}

WorldSnapshot RoomSimulation::tick() {
  ++tick_;
  pendingCombatEvents_.clear();
  pendingProjectileEvents_.clear();

  collectInputs();
  applyMovement();
  processCombat();

  return collectSnapshot();
}

WorldSnapshot RoomSimulation::snapshot() const { return collectSnapshot(); }

std::vector<CombatEvent> RoomSimulation::drainCombatEvents() {
  std::vector<CombatEvent> out;
  out.swap(pendingCombatEvents_);
  return out;
}

std::vector<ProjectileEvent> RoomSimulation::drainProjectileEvents() {
  std::vector<ProjectileEvent> out;
  out.swap(pendingProjectileEvents_);
  return out;
}

void RoomSimulation::collectInputs() {
  for (auto& [playerId, player] : players_) {
    auto latest = inputBuffer_.latest(playerId);
    if (latest.has_value()) {
      frameInputs_[playerId] = latest.value();
      player.lastProcessedInputSeq = latest->inputSeq;
    } else if (!frameInputs_.contains(playerId)) {
      frameInputs_[playerId] = InputFrame{};
    }
  }
}

void RoomSimulation::applyMovement() {
  const float dt = 1.0f / static_cast<float>(tickRate_);

  for (auto& [playerId, player] : players_) {
    if (!player.alive) {
      continue;
    }

    const auto inputFound = frameInputs_.find(playerId);
    if (inputFound == frameInputs_.end()) {
      continue;
    }

    const auto& input = inputFound->second;
    player.velocity.x = static_cast<float>(input.moveX) * kPlayerSpeedMps;
    player.velocity.y = static_cast<float>(input.moveY) * kPlayerSpeedMps;

    player.position.x += player.velocity.x * dt;
    player.position.y += player.velocity.y * dt;

    player.position.x =
        std::clamp(player.position.x, -kWorldBoundary, kWorldBoundary);
    player.position.y =
        std::clamp(player.position.y, -kWorldBoundary, kWorldBoundary);
  }
}

void RoomSimulation::processCombat() {
  auto findNearestTarget = [&](const PlayerState& source,
                               float rangeMeters) -> PlayerState* {
    const float rangeSq = rangeMeters * rangeMeters;
    float best = std::numeric_limits<float>::max();
    PlayerState* bestTarget = nullptr;

    for (auto& [targetId, target] : players_) {
      if (targetId == source.playerId || !target.alive) {
        continue;
      }

      const float d = distSq(source.position, target.position);
      if (d <= rangeSq && d < best) {
        best = d;
        bestTarget = &target;
      }
    }

    return bestTarget;
  };

  auto pushDamageEvents = [&](const PlayerState& source,
                              PlayerState& target,
                              std::uint16_t damage,
                              SkillSlot skillSlot,
                              bool critical) {
    if (!source.alive || !target.alive || damage == 0) {
      return;
    }

    const auto applied = std::min<std::uint16_t>(damage, target.hp);
    if (applied == 0) {
      return;
    }

    target.hp -= applied;

    pendingCombatEvents_.push_back(CombatEvent{
        .type = CombatEventType::DamageApplied,
        .sourcePlayerId = source.playerId,
        .targetPlayerId = target.playerId,
        .skillSlot = skillSlot,
        .damage = applied,
        .critical = critical,
        .serverTick = tick_,
        .position = target.position,
    });

    if (target.hp == 0) {
      target.alive = false;
      target.velocity = Vec2{};

      pendingCombatEvents_.push_back(CombatEvent{
          .type = CombatEventType::Knockout,
          .sourcePlayerId = source.playerId,
          .targetPlayerId = target.playerId,
          .skillSlot = skillSlot,
          .damage = 0,
          .critical = critical,
          .serverTick = tick_,
          .position = target.position,
      });
    }
  };

  for (auto& [playerId, player] : players_) {
    if (!player.alive) {
      continue;
    }

    const auto inputFound = frameInputs_.find(playerId);
    if (inputFound == frameInputs_.end()) {
      continue;
    }

    const auto& input = inputFound->second;
    const auto prevInputFound = previousFrameInputs_.find(playerId);
    const InputFrame prevInput = prevInputFound != previousFrameInputs_.end()
                                     ? prevInputFound->second
                                     : InputFrame{};

    const auto emitSkillCast = [&](SkillSlot slot) {
      pendingCombatEvents_.push_back(CombatEvent{
          .type = CombatEventType::SkillCast,
          .sourcePlayerId = playerId,
          .targetPlayerId = 0,
          .skillSlot = slot,
          .damage = 0,
          .critical = false,
          .serverTick = tick_,
          .position = player.position,
      });
    };

    bool canFireNow = false;
    if (input.firing) {
      const auto fireTickFound = lastFireTick_.find(playerId);
      const bool firstShot = fireTickFound == lastFireTick_.end();
      const std::uint32_t lastFiredTick =
          fireTickFound != lastFireTick_.end() ? fireTickFound->second : 0;

      if (firstShot || tick_ >= lastFiredTick + kFireIntervalTicks) {
        canFireNow = true;
        lastFireTick_[playerId] = tick_;
      }
    }

    if (canFireNow) {
      const auto projectileDirection = directionFromRadian(input.aimRadian);

      pendingCombatEvents_.push_back(CombatEvent{
          .type = CombatEventType::ShotFired,
          .sourcePlayerId = playerId,
          .targetPlayerId = 0,
          .skillSlot = SkillSlot::None,
          .damage = 0,
          .critical = false,
          .serverTick = tick_,
          .position = player.position,
      });

      const std::uint32_t projectileId = nextProjectileId_++;
      pendingProjectileEvents_.push_back(ProjectileEvent{
          .projectileId = projectileId,
          .ownerPlayerId = playerId,
          .targetPlayerId = 0,
          .phase = ProjectilePhase::Spawn,
          .serverTick = tick_,
          .position = player.position,
          .velocity = Vec2{.x = projectileDirection.x * kProjectileSpeed,
                           .y = projectileDirection.y * kProjectileSpeed},
      });

      if (auto* target = findNearestTarget(player, kShotRange); target != nullptr) {
        pushDamageEvents(player, *target, kShotDamage, SkillSlot::None, false);

        pendingProjectileEvents_.push_back(ProjectileEvent{
            .projectileId = projectileId,
            .ownerPlayerId = playerId,
            .targetPlayerId = target->playerId,
            .phase = ProjectilePhase::Hit,
            .serverTick = tick_,
            .position = target->position,
            .velocity = Vec2{},
        });
      }
    }

    const bool castSkillQ = input.skillQ && !prevInput.skillQ;
    const bool castSkillE = input.skillE && !prevInput.skillE;
    const bool castSkillR = input.skillR && !prevInput.skillR;

    if (castSkillQ) {
      emitSkillCast(SkillSlot::Q);
      if (auto* target = findNearestTarget(player, kSkillQRange); target != nullptr) {
        pushDamageEvents(player, *target, kSkillQDamage, SkillSlot::Q, false);
      }
    }

    if (castSkillE) {
      emitSkillCast(SkillSlot::E);
    }

    if (castSkillR) {
      emitSkillCast(SkillSlot::R);

      const float radiusSq = kSkillRRadius * kSkillRRadius;
      for (auto& [targetId, target] : players_) {
        if (targetId == playerId || !target.alive) {
          continue;
        }

        if (distSq(player.position, target.position) <= radiusSq) {
          pushDamageEvents(player, target, kSkillRDamage, SkillSlot::R, true);
        }
      }
    }

    previousFrameInputs_[playerId] = input;
  }
}

WorldSnapshot RoomSimulation::collectSnapshot() const {
  WorldSnapshot snapshot;
  snapshot.serverTick = tick_;
  snapshot.players.reserve(players_.size());

  for (const auto& [_, player] : players_) {
    snapshot.players.push_back(player);
  }

  return snapshot;
}

}  // namespace wildpaw::room
