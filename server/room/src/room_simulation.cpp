#include "room/room_simulation.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

#include "room/combat_rule_table.hpp"

namespace wildpaw::room {

namespace {
constexpr float kPlayerSpeedMps = 4.0f;
constexpr float kPlayerCollisionRadius = 0.45f;

float distSq(const Vec2& a, const Vec2& b) {
  const float dx = a.x - b.x;
  const float dy = a.y - b.y;
  return dx * dx + dy * dy;
}

Vec2 directionFromRadian(float radian) {
  // aimRadian은 클라이언트에서 atan2(aimDx, aimDy) 규약으로 전송된다.
  // 따라서 월드 방향 복원은 (sin, cos) 순서여야 조준축과 일치한다.
  return Vec2{.x = std::sin(radian), .y = std::cos(radian)};
}

bool segmentIntersectsAabb2D(float x0,
                             float y0,
                             float x1,
                             float y1,
                             const StaticCollider& collider,
                             float padding = 0.0f) {
  const float minX = collider.minX - padding;
  const float maxX = collider.maxX + padding;
  const float minY = collider.minY - padding;
  const float maxY = collider.maxY + padding;

  const float dx = x1 - x0;
  const float dy = y1 - y0;

  float tMin = 0.0f;
  float tMax = 1.0f;

  if (std::abs(dx) < 1e-7f) {
    if (x0 < minX || x0 > maxX) {
      return false;
    }
  } else {
    const float invDx = 1.0f / dx;
    float t1 = (minX - x0) * invDx;
    float t2 = (maxX - x0) * invDx;
    if (t1 > t2) {
      std::swap(t1, t2);
    }

    tMin = std::max(tMin, t1);
    tMax = std::min(tMax, t2);
    if (tMin > tMax) {
      return false;
    }
  }

  if (std::abs(dy) < 1e-7f) {
    if (y0 < minY || y0 > maxY) {
      return false;
    }
  } else {
    const float invDy = 1.0f / dy;
    float t1 = (minY - y0) * invDy;
    float t2 = (maxY - y0) * invDy;
    if (t1 > t2) {
      std::swap(t1, t2);
    }

    tMin = std::max(tMin, t1);
    tMax = std::min(tMax, t2);
    if (tMin > tMax) {
      return false;
    }
  }

  return true;
}

}  // namespace

RoomSimulation::RoomSimulation(std::uint32_t tickRate)
    : tickRate_(tickRate), inputBuffer_(256) {}

void RoomSimulation::addPlayer(std::uint32_t playerId,
                               std::uint8_t teamId,
                               std::uint16_t teamSlot) {
  PlayerState state;
  state.playerId = playerId;
  state.teamId = teamId;
  state.teamSlot = teamSlot;

  // 단순 스폰 분산: 초기 중첩을 피하기 위해 원형 배치.
  const float ringRadius = 3.0f;
  const float angle =
      static_cast<float>((players_.size() % 12) * (3.1415926535 / 6.0));
  state.position = {ringRadius * std::cos(angle), ringRadius * std::sin(angle)};
  state.velocity = {0.0f, 0.0f};

  auto profileIds = combatRuleProfileIds();
  std::sort(profileIds.begin(), profileIds.end());

  if (!profileIds.empty()) {
    state.profileId = profileIds[players_.size() % profileIds.size()];
  } else {
    state.profileId = defaultCombatRuleProfileId();
  }

  const auto rules = combatRuleForProfile(state.profileId);
  state.maxAmmo = rules.maxAmmo;
  state.ammo = rules.maxAmmo;

  players_[playerId] = state;
}

bool RoomSimulation::setPlayerProfile(std::uint32_t playerId,
                                      std::string_view profileId) {
  auto playerFound = players_.find(playerId);
  if (playerFound == players_.end()) {
    return false;
  }

  const auto profileIds = combatRuleProfileIds();
  const bool exists =
      std::find(profileIds.begin(), profileIds.end(), profileId) != profileIds.end();
  if (!exists) {
    return false;
  }

  auto& player = playerFound->second;
  player.profileId = std::string{profileId};

  const auto rules = combatRuleForProfile(player.profileId);
  player.maxAmmo = rules.maxAmmo;
  player.ammo = rules.maxAmmo;

  player.reloading = false;
  player.reloadRemainingTicks = 0;
  player.castingSkill = SkillSlot::None;
  player.castRemainingTicks = 0;
  player.skillQCooldownTicks = 0;
  player.skillECooldownTicks = 0;
  player.skillRCooldownTicks = 0;

  return true;
}

void RoomSimulation::setMapBounds(float minX,
                                  float maxX,
                                  float minY,
                                  float maxY) {
  worldMinX_ = std::min(minX, maxX);
  worldMaxX_ = std::max(minX, maxX);
  worldMinY_ = std::min(minY, maxY);
  worldMaxY_ = std::max(minY, maxY);
}

void RoomSimulation::setStaticColliders(std::vector<StaticCollider> colliders) {
  staticColliders_ = std::move(colliders);
}

void RoomSimulation::removePlayer(std::uint32_t playerId) {
  players_.erase(playerId);
  frameInputs_.erase(playerId);
  previousFrameInputs_.erase(playerId);
  lastFireTick_.erase(playerId);

  pendingSkillCasts_.erase(
      std::remove_if(pendingSkillCasts_.begin(), pendingSkillCasts_.end(),
                     [playerId](const PendingSkillCast& cast) {
                       return cast.sourcePlayerId == playerId;
                     }),
      pendingSkillCasts_.end());
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

    player.position.x = std::clamp(player.position.x, worldMinX_, worldMaxX_);
    player.position.y = std::clamp(player.position.y, worldMinY_, worldMaxY_);

    for (const auto& collider : staticColliders_) {
      if (!collider.blocksMovement) {
        continue;
      }

      const float minX = collider.minX - kPlayerCollisionRadius;
      const float maxX = collider.maxX + kPlayerCollisionRadius;
      const float minY = collider.minY - kPlayerCollisionRadius;
      const float maxY = collider.maxY + kPlayerCollisionRadius;

      const bool insideX = player.position.x > minX && player.position.x < maxX;
      const bool insideY = player.position.y > minY && player.position.y < maxY;
      if (!insideX || !insideY) {
        continue;
      }

      const float leftDist = std::abs(player.position.x - minX);
      const float rightDist = std::abs(maxX - player.position.x);
      const float downDist = std::abs(player.position.y - minY);
      const float upDist = std::abs(maxY - player.position.y);

      const float minDist = std::min({leftDist, rightDist, downDist, upDist});
      if (minDist == leftDist) {
        player.position.x = minX;
      } else if (minDist == rightDist) {
        player.position.x = maxX;
      } else if (minDist == downDist) {
        player.position.y = minY;
      } else {
        player.position.y = maxY;
      }
    }

    player.position.x = std::clamp(player.position.x, worldMinX_, worldMaxX_);
    player.position.y = std::clamp(player.position.y, worldMinY_, worldMaxY_);
  }
}

void RoomSimulation::processCombat() {
  auto findNearestTargetInRange = [&](const PlayerState& source,
                                      float rangeMeters) -> PlayerState* {
    if (rangeMeters <= 0.0f) {
      return nullptr;
    }

    const float rangeSq = rangeMeters * rangeMeters;
    float best = std::numeric_limits<float>::max();
    PlayerState* bestTarget = nullptr;

    for (auto& [targetId, target] : players_) {
      if (targetId == source.playerId || !target.alive ||
          (source.teamId != 0 && target.teamId == source.teamId)) {
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

  auto findShotTarget = [&](const PlayerState& source,
                            float rangeMeters,
                            float aimRadian) -> PlayerState* {
    if (rangeMeters <= 0.0f) {
      return nullptr;
    }

    constexpr float kShotHitRadiusMeters = 0.65f;
    const Vec2 direction = directionFromRadian(aimRadian);

    float bestScore = std::numeric_limits<float>::max();
    PlayerState* bestTarget = nullptr;

    for (auto& [targetId, target] : players_) {
      if (targetId == source.playerId || !target.alive ||
          (source.teamId != 0 && target.teamId == source.teamId)) {
        continue;
      }

      const float toX = target.position.x - source.position.x;
      const float toY = target.position.y - source.position.y;

      const float forward = toX * direction.x + toY * direction.y;
      if (forward < 0.0f || forward > rangeMeters) {
        continue;
      }

      const float lateral = std::abs(toX * direction.y - toY * direction.x);
      if (lateral > kShotHitRadiusMeters) {
        continue;
      }

      bool blockedBySight = false;
      for (const auto& collider : staticColliders_) {
        if (!collider.blocksLineOfSight && !collider.blocksProjectile) {
          continue;
        }

        if (segmentIntersectsAabb2D(source.position.x, source.position.y,
                                    target.position.x, target.position.y,
                                    collider, 0.02f)) {
          blockedBySight = true;
          break;
        }
      }

      if (blockedBySight) {
        continue;
      }

      const float score = forward + lateral * 0.25f;
      if (score < bestScore) {
        bestScore = score;
        bestTarget = &target;
      }
    }

    return bestTarget;
  };

  auto maybeStartReload = [&](PlayerState& player,
                              const CombatRuleTable& rules) {
    if (player.reloading || !player.alive) {
      return;
    }

    if (player.ammo == 0 && rules.reloadTicks > 0) {
      player.reloading = true;
      player.reloadRemainingTicks = rules.reloadTicks;
    }
  };

  auto consumeAmmo = [&](PlayerState& player,
                         const CombatRuleTable& rules,
                         std::uint16_t amount) -> bool {
    if (amount == 0) {
      return true;
    }

    if (!player.alive || player.reloading || player.ammo < amount) {
      return false;
    }

    player.ammo = static_cast<std::uint16_t>(player.ammo - amount);
    maybeStartReload(player, rules);
    return true;
  };

  auto pushDamageEvents = [&](const PlayerState& source,
                              PlayerState& target,
                              std::uint16_t damage,
                              SkillSlot skillSlot,
                              bool critical) {
    if (!source.alive || !target.alive || damage == 0) {
      return;
    }

    if (source.teamId != 0 && source.teamId == target.teamId) {
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
      target.reloading = false;
      target.reloadRemainingTicks = 0;
      target.castingSkill = SkillSlot::None;
      target.castRemainingTicks = 0;

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

  auto executeSkill = [&](PlayerState& source, SkillSlot slot) {
    if (!source.alive) {
      return;
    }

    const auto sourceRules = combatRuleForProfile(source.profileId);

    if (slot == SkillSlot::Q) {
      const auto& rule = sourceRules.skillQ;
      if (auto* target = findNearestTargetInRange(source, rule.rangeMeters);
          target != nullptr) {
        pushDamageEvents(source, *target, rule.damage, SkillSlot::Q, rule.critical);
      }
      return;
    }

    if (slot == SkillSlot::E) {
      // E는 이동/유틸 스킬 자리. 현재 스캐폴드에서는 상태 이벤트만 발행.
      return;
    }

    if (slot == SkillSlot::R) {
      const auto& rule = sourceRules.skillR;
      const float radiusSq = rule.radiusMeters * rule.radiusMeters;

      for (auto& [targetId, target] : players_) {
        if (targetId == source.playerId || !target.alive ||
            (source.teamId != 0 && target.teamId == source.teamId)) {
          continue;
        }

        if (distSq(source.position, target.position) <= radiusSq) {
          pushDamageEvents(source, target, rule.damage, SkillSlot::R,
                           rule.critical);
        }
      }
    }
  };

  // 1) 틱 단위 상태 감소 (쿨다운/캐스트/재장전)
  for (auto& [_, player] : players_) {
    const auto rules = combatRuleForProfile(player.profileId);

    // 룰 핫리로드 반영: 탄약 상한/재장전 길이 보정.
    if (player.maxAmmo != rules.maxAmmo) {
      player.maxAmmo = rules.maxAmmo;
      player.ammo = std::min(player.ammo, player.maxAmmo);
    }

    if (player.reloading && player.reloadRemainingTicks > rules.reloadTicks) {
      player.reloadRemainingTicks = rules.reloadTicks;
    }

    if (player.reloadRemainingTicks > 0) {
      --player.reloadRemainingTicks;
      if (player.reloadRemainingTicks == 0) {
        player.reloading = false;
        player.ammo = player.maxAmmo;
      }
    }

    if (player.skillQCooldownTicks > 0) {
      --player.skillQCooldownTicks;
    }
    if (player.skillECooldownTicks > 0) {
      --player.skillECooldownTicks;
    }
    if (player.skillRCooldownTicks > 0) {
      --player.skillRCooldownTicks;
    }

    if (player.castRemainingTicks > 0) {
      --player.castRemainingTicks;
      if (player.castRemainingTicks == 0) {
        player.castingSkill = SkillSlot::None;
      }
    }
  }

  // 2) 캐스트 타임이 끝난 스킬 적용
  if (!pendingSkillCasts_.empty()) {
    std::vector<PendingSkillCast> stillPending;
    stillPending.reserve(pendingSkillCasts_.size());

    for (const auto& cast : pendingSkillCasts_) {
      if (cast.executeTick > tick_) {
        stillPending.push_back(cast);
        continue;
      }

      auto sourceFound = players_.find(cast.sourcePlayerId);
      if (sourceFound == players_.end()) {
        continue;
      }

      auto& source = sourceFound->second;
      if (!source.alive) {
        continue;
      }

      source.castingSkill = SkillSlot::None;
      source.castRemainingTicks = 0;
      executeSkill(source, cast.slot);
    }

    pendingSkillCasts_.swap(stillPending);
  }

  // 3) 현재 입력 기반 사격/스킬 시전
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

    const auto rules = combatRuleForProfile(player.profileId);

    // 캐스팅 중에는 공격/스킬 입력 잠금.
    bool actionLocked = player.castRemainingTicks > 0;

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

    if (!actionLocked && input.firing && !player.reloading &&
        player.ammo >= rules.ammoPerShot) {
      const auto fireTickFound = lastFireTick_.find(playerId);
      const bool firstShot = fireTickFound == lastFireTick_.end();
      const std::uint32_t lastFiredTick =
          fireTickFound != lastFireTick_.end() ? fireTickFound->second : 0;

      if (firstShot || tick_ >= lastFiredTick + rules.fireIntervalTicks) {
        lastFireTick_[playerId] = tick_;

        if (consumeAmmo(player, rules, rules.ammoPerShot)) {
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
              .velocity =
                  Vec2{.x = projectileDirection.x * rules.projectileSpeed,
                       .y = projectileDirection.y * rules.projectileSpeed},
          });

          if (auto* target =
                  findShotTarget(player, rules.shotRangeMeters, input.aimRadian);
              target != nullptr) {
            pushDamageEvents(player, *target, rules.shotDamage, SkillSlot::None,
                             false);

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
      }
    }

    auto requestSkillCast = [&](SkillSlot slot, const SkillRule& rule,
                                std::uint32_t& cooldownTicks) {
      if (actionLocked || !player.alive) {
        return;
      }
      if (cooldownTicks > 0 || player.reloading) {
        return;
      }
      if (!consumeAmmo(player, rules, rule.ammoCost)) {
        return;
      }

      cooldownTicks = rule.cooldownTicks;
      emitSkillCast(slot);
      actionLocked = true;

      if (rule.castTimeTicks > 0) {
        player.castingSkill = slot;
        player.castRemainingTicks = rule.castTimeTicks;
        pendingSkillCasts_.push_back(PendingSkillCast{
            .sourcePlayerId = playerId,
            .slot = slot,
            .executeTick = tick_ + rule.castTimeTicks,
            .aimRadian = input.aimRadian,
        });
      } else {
        executeSkill(player, slot);
      }
    };

    const bool castSkillQ = input.skillQ && !prevInput.skillQ;
    const bool castSkillE = input.skillE && !prevInput.skillE;
    const bool castSkillR = input.skillR && !prevInput.skillR;

    if (castSkillQ) {
      requestSkillCast(SkillSlot::Q, rules.skillQ, player.skillQCooldownTicks);
    }
    if (castSkillE) {
      requestSkillCast(SkillSlot::E, rules.skillE, player.skillECooldownTicks);
    }
    if (castSkillR) {
      requestSkillCast(SkillSlot::R, rules.skillR, player.skillRCooldownTicks);
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
