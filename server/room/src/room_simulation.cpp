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
constexpr float kProjectileHitRadiusMeters = 0.65f;
constexpr float kSpawnSlotSpacingMeters = 1.25f;

std::uint32_t durationTicksFromMilliseconds(std::uint32_t durationMs,
                                            std::uint32_t tickRate) {
  const std::uint64_t scaled =
      static_cast<std::uint64_t>(durationMs) * std::max(1u, tickRate);
  return std::max<std::uint32_t>(
      1, static_cast<std::uint32_t>((scaled + 999u) / 1000u));
}

std::uint32_t projectileTravelTicks(float distanceMeters,
                                    float speedMetersPerSecond,
                                    std::uint32_t tickRate) {
  if (distanceMeters <= 0.0f || speedMetersPerSecond <= 0.0f) {
    return 1;
  }

  const float travelSeconds = distanceMeters / speedMetersPerSecond;
  const float travelTicks = travelSeconds * static_cast<float>(std::max(1u, tickRate));
  return std::max(1u, static_cast<std::uint32_t>(std::ceil(travelTicks)));
}

struct HeroRuleProfileMapping {
  std::string_view mHeroId;
  std::string_view mPrimaryProfileId;
  std::string_view mFallbackProfileId;
};

constexpr HeroRuleProfileMapping kHeroRuleProfileMappings[] = {
    {"iris_wolf", "iris_wolf", "ranger"},
    {"coral_cat", "coral_cat", "ranger"},
    {"bruno_bear", "bruno_bear", "bruiser"},
    {"lumifox", "lumifox", "skirmisher"},
    {"stinkrat", "stinkrat", "ranger"},
    {"milky_rabbit", "milky_rabbit", "ranger"},
    {"rockhorn_rhino", "rockhorn_rhino", "bruiser"},
    {"pearl_panda", "pearl_panda", "ranger"},
};

std::string_view normalizeHeroId(std::string_view selectionId) {
  return selectionId == "whitecat_commando" ? std::string_view{"coral_cat"}
                                               : selectionId;
}

const HeroRuleProfileMapping* findHeroMapping(std::string_view selectionId) {
  const auto heroId = normalizeHeroId(selectionId);
  for (const auto& mapping : kHeroRuleProfileMappings) {
    if (mapping.mHeroId == heroId) {
      return &mapping;
    }
  }
  return nullptr;
}

bool hasProfile(const std::vector<std::string>& profileIds,
                std::string_view profileId) {
  return std::find(profileIds.begin(), profileIds.end(), profileId) !=
         profileIds.end();
}

std::optional<std::string> resolveRuleProfileId(
    std::string_view selectionId,
    const std::vector<std::string>& profileIds) {
  const auto* heroMapping = findHeroMapping(selectionId);
  if (heroMapping == nullptr) {
    if (hasProfile(profileIds, selectionId)) {
      return std::string{selectionId};
    }
    return std::nullopt;
  }

  if (hasProfile(profileIds, heroMapping->mPrimaryProfileId)) {
    return std::string{heroMapping->mPrimaryProfileId};
  }
  if (hasProfile(profileIds, heroMapping->mFallbackProfileId)) {
    return std::string{heroMapping->mFallbackProfileId};
  }

  const auto defaultProfileId = defaultCombatRuleProfileId();
  if (hasProfile(profileIds, defaultProfileId)) {
    return defaultProfileId;
  }
  return std::nullopt;
}

std::string defaultHeroIdForProfile(std::string_view profileId) {
  if (profileId == "coral_cat") {
    return "coral_cat";
  }
  if (profileId == "bruno_bear" || profileId == "bruiser") {
    return "bruno_bear";
  }
  if (profileId == "skirmisher") {
    return "lumifox";
  }
  return "iris_wolf";
}

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

bool isInsideMovementCollider(const Vec2& position,
                              const StaticCollider& collider,
                              float radiusPadding = kPlayerCollisionRadius) {
  if (!collider.blocksMovement) {
    return false;
  }

  const float minX = collider.minX - radiusPadding;
  const float maxX = collider.maxX + radiusPadding;
  const float minY = collider.minY - radiusPadding;
  const float maxY = collider.maxY + radiusPadding;

  return position.x > minX && position.x < maxX && position.y > minY &&
         position.y < maxY;
}

bool isBlockedByMovement(const Vec2& position,
                         const std::vector<StaticCollider>& colliders) {
  for (const auto& collider : colliders) {
    if (isInsideMovementCollider(position, collider)) {
      return true;
    }
  }
  return false;
}

void resolveMovementPenetration(Vec2& position,
                                const std::vector<StaticCollider>& colliders) {
  for (const auto& collider : colliders) {
    if (!isInsideMovementCollider(position, collider)) {
      continue;
    }

    const float minX = collider.minX - kPlayerCollisionRadius;
    const float maxX = collider.maxX + kPlayerCollisionRadius;
    const float minY = collider.minY - kPlayerCollisionRadius;
    const float maxY = collider.maxY + kPlayerCollisionRadius;

    const float leftDist = std::abs(position.x - minX);
    const float rightDist = std::abs(maxX - position.x);
    const float downDist = std::abs(position.y - minY);
    const float upDist = std::abs(maxY - position.y);

    const float minDist = std::min({leftDist, rightDist, downDist, upDist});
    if (minDist == leftDist) {
      position.x = minX;
    } else if (minDist == rightDist) {
      position.x = maxX;
    } else if (minDist == downDist) {
      position.y = minY;
    } else {
      position.y = maxY;
    }
  }
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

  const auto approvedSpawn = resolveTeamSpawn(teamId, teamSlot);
  if (approvedSpawn.has_value()) {
    state.position = approvedSpawn.value();
  } else {
    // 맵 스폰 정보가 없을 때만 기존 개발용 원형 배치를 사용한다.
    const float ringRadius = 3.0f;
    const float angle =
        static_cast<float>((players_.size() % 12) * (3.1415926535 / 6.0));
    state.position = {ringRadius * std::cos(angle), ringRadius * std::sin(angle)};
  }
  state.velocity = {0.0f, 0.0f};

  auto profileIds = combatRuleProfileIds();
  std::sort(profileIds.begin(), profileIds.end());

  if (!profileIds.empty()) {
    state.profileId = profileIds[players_.size() % profileIds.size()];
  } else {
    state.profileId = defaultCombatRuleProfileId();
  }
  state.mHeroId = defaultHeroIdForProfile(state.profileId);

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
  const auto resolvedProfileId = resolveRuleProfileId(profileId, profileIds);
  if (!resolvedProfileId.has_value()) {
    return false;
  }

  cancelPendingSkillCasts(playerId);

  auto& player = playerFound->second;
  player.profileId = resolvedProfileId.value();
  if (const auto* heroMapping = findHeroMapping(profileId);
      heroMapping != nullptr) {
    player.mHeroId = std::string{heroMapping->mHeroId};
  } else {
    player.mHeroId = defaultHeroIdForProfile(player.profileId);
  }

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

void RoomSimulation::setTeamSpawnPoints(
    std::vector<TeamSpawnPoint> spawnPoints) {
  mTeamSpawnPoints = std::move(spawnPoints);
}

std::optional<Vec2> RoomSimulation::resolveTeamSpawn(
    std::uint8_t teamId,
    std::uint16_t teamSlot) const {
  std::uint32_t firstPhase = std::numeric_limits<std::uint32_t>::max();
  for (const auto& spawnPoint : mTeamSpawnPoints) {
    if (spawnPoint.mTeamId == teamId) {
      firstPhase = std::min(firstPhase, spawnPoint.mPhase);
    }
  }

  if (firstPhase == std::numeric_limits<std::uint32_t>::max()) {
    return std::nullopt;
  }

  std::size_t candidateCount = 0;
  for (const auto& spawnPoint : mTeamSpawnPoints) {
    if (spawnPoint.mTeamId == teamId && spawnPoint.mPhase == firstPhase) {
      ++candidateCount;
    }
  }

  if (candidateCount == 0) {
    return std::nullopt;
  }

  const std::size_t slotIndex = teamSlot > 0 ? teamSlot - 1u : 0u;
  const std::size_t selectedIndex = slotIndex % candidateCount;
  const TeamSpawnPoint* selectedSpawn = nullptr;
  std::size_t candidateIndex = 0;

  for (const auto& spawnPoint : mTeamSpawnPoints) {
    if (spawnPoint.mTeamId != teamId || spawnPoint.mPhase != firstPhase) {
      continue;
    }
    if (candidateIndex == selectedIndex) {
      selectedSpawn = &spawnPoint;
      break;
    }
    ++candidateIndex;
  }

  if (selectedSpawn == nullptr) {
    return std::nullopt;
  }

  Vec2 position = selectedSpawn->mPosition;
  const std::size_t repeatIndex = slotIndex / candidateCount;
  if (repeatIndex > 0) {
    const std::size_t magnitude = (repeatIndex + 1u) / 2u;
    const float direction = repeatIndex % 2u == 1u ? 1.0f : -1.0f;
    const float maxOffset = std::max(0.0f, selectedSpawn->mRadius * 0.75f);
    const float offset = std::min(
        static_cast<float>(magnitude) * kSpawnSlotSpacingMeters, maxOffset);
    position.y += direction * offset;
  }

  position.x = std::clamp(position.x, worldMinX_, worldMaxX_);
  position.y = std::clamp(position.y, worldMinY_, worldMaxY_);
  return position;
}

void RoomSimulation::removePlayer(std::uint32_t playerId) {
  cancelPendingSkillCasts(playerId);
  removeStatusEffectsForPlayer(playerId, false);

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
  mPendingStatusEffectEvents.clear();

  processProjectileLifecycle();
  processStatusEffectLifecycle();
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

std::vector<StatusEffectEvent> RoomSimulation::drainStatusEffectEvents() {
  std::vector<StatusEffectEvent> out;
  out.swap(mPendingStatusEffectEvents);
  return out;
}

bool RoomSimulation::hasActiveStatusEffect(std::uint32_t playerId,
                                           StatusEffectKind kind) const {
  return std::any_of(
      mPendingStatusEffects.begin(), mPendingStatusEffects.end(),
      [this, playerId, kind](const PendingStatusEffect& effect) {
        return effect.mTargetPlayerId == playerId && effect.mKind == kind &&
               effect.mExpireTick > tick_;
      });
}

float RoomSimulation::activeStatusEffectMagnitude(
    std::uint32_t playerId,
    StatusEffectKind kind) const {
  float magnitude = 0.0f;
  for (const auto& effect : mPendingStatusEffects) {
    if (effect.mTargetPlayerId != playerId || effect.mKind != kind ||
        effect.mExpireTick <= tick_ || !std::isfinite(effect.mMagnitude)) {
      continue;
    }

    magnitude = std::max(magnitude, effect.mMagnitude);
  }
  return magnitude;
}

void RoomSimulation::cancelPendingSkillCasts(std::uint32_t playerId) {
  pendingSkillCasts_.erase(
      std::remove_if(pendingSkillCasts_.begin(), pendingSkillCasts_.end(),
                     [playerId](const PendingSkillCast& cast) {
                       return cast.sourcePlayerId == playerId;
                     }),
      pendingSkillCasts_.end());

  const auto playerFound = players_.find(playerId);
  if (playerFound == players_.end()) {
    return;
  }

  playerFound->second.castingSkill = SkillSlot::None;
  playerFound->second.castRemainingTicks = 0;
}

void RoomSimulation::removeStatusEffectsForPlayer(
    std::uint32_t playerId,
    bool emitRemoveEvents) {
  auto effect = mPendingStatusEffects.begin();
  while (effect != mPendingStatusEffects.end()) {
    if (effect->mTargetPlayerId != playerId) {
      ++effect;
      continue;
    }

    if (emitRemoveEvents) {
      mPendingStatusEffectEvents.push_back(StatusEffectEvent{
          .mEffectId = effect->mEffectId,
          .mSourcePlayerId = effect->mSourcePlayerId,
          .mTargetPlayerId = effect->mTargetPlayerId,
          .mKind = effect->mKind,
          .mPhase = StatusEffectPhase::Remove,
          .mDurationTicks = 0,
          .mMagnitude = 0.0f,
          .mServerTick = tick_,
      });
    }

    effect = mPendingStatusEffects.erase(effect);
  }

  const auto playerFound = players_.find(playerId);
  if (playerFound != players_.end()) {
    playerFound->second.mShield = 0;
  }
}

void RoomSimulation::applyDamageFromSource(std::uint32_t sourcePlayerId,
                                           std::uint8_t sourceTeamId,
                                           PlayerState& target,
                                           std::uint16_t damage,
                                           SkillSlot skillSlot,
                                           bool critical) {
  if (!target.alive || damage == 0) {
    return;
  }

  if (sourceTeamId != 0 && sourceTeamId == target.teamId) {
    return;
  }

  std::uint16_t remainingDamage = damage;
  auto effect = mPendingStatusEffects.begin();
  while (effect != mPendingStatusEffects.end() && remainingDamage > 0) {
    if (effect->mTargetPlayerId != target.playerId ||
        effect->mKind != StatusEffectKind::Shield ||
        effect->mExpireTick <= tick_ || effect->mMagnitude <= 0.0f) {
      ++effect;
      continue;
    }

    const auto shieldPoints = static_cast<std::uint16_t>(std::clamp(
        effect->mMagnitude, 0.0f,
        static_cast<float>(std::numeric_limits<std::uint16_t>::max())));
    const auto absorbed = std::min(remainingDamage, shieldPoints);
    remainingDamage = static_cast<std::uint16_t>(remainingDamage - absorbed);
    effect->mMagnitude -= static_cast<float>(absorbed);
    target.mShield = target.mShield >= absorbed
                         ? static_cast<std::uint16_t>(target.mShield - absorbed)
                         : 0;

    if (effect->mMagnitude <= 0.0f) {
      mPendingStatusEffectEvents.push_back(StatusEffectEvent{
          .mEffectId = effect->mEffectId,
          .mSourcePlayerId = effect->mSourcePlayerId,
          .mTargetPlayerId = effect->mTargetPlayerId,
          .mKind = effect->mKind,
          .mPhase = StatusEffectPhase::Remove,
          .mDurationTicks = 0,
          .mMagnitude = 0.0f,
          .mServerTick = tick_,
      });
      effect = mPendingStatusEffects.erase(effect);
      continue;
    }

    mPendingStatusEffectEvents.push_back(StatusEffectEvent{
        .mEffectId = effect->mEffectId,
        .mSourcePlayerId = effect->mSourcePlayerId,
        .mTargetPlayerId = effect->mTargetPlayerId,
        .mKind = effect->mKind,
        .mPhase = StatusEffectPhase::Apply,
        .mDurationTicks = effect->mExpireTick - tick_,
        .mMagnitude = effect->mMagnitude,
        .mServerTick = tick_,
    });
    ++effect;
  }

  const auto applied = std::min<std::uint16_t>(remainingDamage, target.hp);
  if (applied == 0) {
    return;
  }

  target.hp -= applied;

  pendingCombatEvents_.push_back(CombatEvent{
      .type = CombatEventType::DamageApplied,
      .sourcePlayerId = sourcePlayerId,
      .targetPlayerId = target.playerId,
      .skillSlot = skillSlot,
      .damage = applied,
      .critical = critical,
      .serverTick = tick_,
      .position = target.position,
  });

  if (target.hp != 0) {
    return;
  }

  target.alive = false;
  target.velocity = Vec2{};
  target.reloading = false;
  target.reloadRemainingTicks = 0;
  cancelPendingSkillCasts(target.playerId);
  removeStatusEffectsForPlayer(target.playerId, true);

  pendingCombatEvents_.push_back(CombatEvent{
      .type = CombatEventType::Knockout,
      .sourcePlayerId = sourcePlayerId,
      .targetPlayerId = target.playerId,
      .skillSlot = skillSlot,
      .damage = 0,
      .critical = critical,
      .serverTick = tick_,
      .position = target.position,
  });
}

void RoomSimulation::processProjectileLifecycle() {
  if (mPendingProjectiles.empty()) {
    return;
  }

  std::vector<PendingProjectile> remaining;
  remaining.reserve(mPendingProjectiles.size());

  for (const auto& projectile : mPendingProjectiles) {
    if (projectile.mTerminalTick > tick_) {
      remaining.push_back(projectile);
      continue;
    }

    auto terminalPhase = projectile.mTerminalPhase;
    auto terminalTargetPlayerId = projectile.mTargetPlayerId;
    auto terminalPosition = projectile.mTerminalPosition;

    if (terminalPhase == ProjectilePhase::Hit) {
      const auto targetFound = players_.find(projectile.mTargetPlayerId);
      bool pathBlocked = false;
      for (const auto& collider : staticColliders_) {
        if (!collider.blocksLineOfSight && !collider.blocksProjectile) {
          continue;
        }

        if (segmentIntersectsAabb2D(
                projectile.mOriginPosition.x, projectile.mOriginPosition.y,
                projectile.mTerminalPosition.x,
                projectile.mTerminalPosition.y, collider, 0.02f)) {
          pathBlocked = true;
          break;
        }
      }

      const bool targetAtTerminal =
          targetFound != players_.end() && targetFound->second.alive &&
          distSq(targetFound->second.position, projectile.mTerminalPosition) <=
              kProjectileHitRadiusMeters * kProjectileHitRadiusMeters;

      if (!targetAtTerminal || pathBlocked) {
        terminalPhase = ProjectilePhase::Despawn;
        terminalTargetPlayerId = 0;
      } else {
        applyDamageFromSource(
            projectile.mOwnerPlayerId, projectile.mOwnerTeamId,
            targetFound->second, projectile.mDamage, SkillSlot::None,
            projectile.mCritical);
      }
    }

    pendingProjectileEvents_.push_back(ProjectileEvent{
        .projectileId = projectile.mProjectileId,
        .ownerPlayerId = projectile.mOwnerPlayerId,
        .targetPlayerId = terminalTargetPlayerId,
        .phase = terminalPhase,
        .serverTick = tick_,
        .position = terminalPosition,
        .velocity = projectile.mVelocity,
    });
  }

  mPendingProjectiles.swap(remaining);
}

void RoomSimulation::processStatusEffectLifecycle() {
  if (mPendingStatusEffects.empty()) {
    return;
  }

  std::vector<PendingStatusEffect> remaining;
  remaining.reserve(mPendingStatusEffects.size());

  for (const auto& effect : mPendingStatusEffects) {
    if (effect.mExpireTick > tick_) {
      remaining.push_back(effect);
      continue;
    }

    if (effect.mKind == StatusEffectKind::Shield) {
      const auto playerFound = players_.find(effect.mTargetPlayerId);
      if (playerFound != players_.end()) {
        const auto shieldPoints = static_cast<std::uint16_t>(std::clamp(
            effect.mMagnitude, 0.0f,
            static_cast<float>(std::numeric_limits<std::uint16_t>::max())));
        auto& shield = playerFound->second.mShield;
        shield = shield >= shieldPoints
                     ? static_cast<std::uint16_t>(shield - shieldPoints)
                     : 0;
      }
    }

    mPendingStatusEffectEvents.push_back(StatusEffectEvent{
        .mEffectId = effect.mEffectId,
        .mSourcePlayerId = effect.mSourcePlayerId,
        .mTargetPlayerId = effect.mTargetPlayerId,
        .mKind = effect.mKind,
        .mPhase = StatusEffectPhase::Remove,
        .mDurationTicks = 0,
        .mMagnitude = 0.0f,
        .mServerTick = tick_,
    });
  }

  mPendingStatusEffects.swap(remaining);
}

void RoomSimulation::collectInputs() {
  for (auto& [playerId, player] : players_) {
    auto latest = inputBuffer_.latest(playerId);
    if (latest.has_value()) {
      frameInputs_[playerId] = latest.value();
      player.lastProcessedInputSeq = latest->inputSeq;
      player.mAimRadian = latest->aimRadian;
    } else if (!frameInputs_.contains(playerId)) {
      frameInputs_[playerId] = InputFrame{};
    }
  }
}

void RoomSimulation::applyMovement() {
  const float dt = 1.0f / static_cast<float>(tickRate_);
  constexpr float kMaxSubStepMeters = 0.06f;

  for (auto& [playerId, player] : players_) {
    if (!player.alive) {
      continue;
    }

    if (hasActiveStatusEffect(playerId, StatusEffectKind::Stun)) {
      player.velocity = Vec2{};
      continue;
    }

    const auto inputFound = frameInputs_.find(playerId);
    if (inputFound == frameInputs_.end()) {
      continue;
    }

    const auto& input = inputFound->second;
    const float slowMagnitude = std::clamp(
        activeStatusEffectMagnitude(playerId, StatusEffectKind::Slow), 0.0f,
        1.0f);
    const float movementSpeed = kPlayerSpeedMps * (1.0f - slowMagnitude);
    player.velocity.x = static_cast<float>(input.moveX) * movementSpeed;
    player.velocity.y = static_cast<float>(input.moveY) * movementSpeed;

    Vec2 resolved = player.position;
    resolved.x = std::clamp(resolved.x, worldMinX_, worldMaxX_);
    resolved.y = std::clamp(resolved.y, worldMinY_, worldMaxY_);
    resolveMovementPenetration(resolved, staticColliders_);

    Vec2 desired = {
        .x = std::clamp(resolved.x + player.velocity.x * dt, worldMinX_, worldMaxX_),
        .y = std::clamp(resolved.y + player.velocity.y * dt, worldMinY_, worldMaxY_),
    };

    const float moveX = desired.x - resolved.x;
    const float moveY = desired.y - resolved.y;
    const float maxAxisMove = std::max(std::abs(moveX), std::abs(moveY));

    const int stepCount = std::max(
        1, static_cast<int>(std::ceil(maxAxisMove / kMaxSubStepMeters)));
    const float stepX = moveX / static_cast<float>(stepCount);
    const float stepY = moveY / static_cast<float>(stepCount);

    for (int step = 0; step < stepCount; ++step) {
      Vec2 candidate = {
          .x = std::clamp(resolved.x + stepX, worldMinX_, worldMaxX_),
          .y = std::clamp(resolved.y + stepY, worldMinY_, worldMaxY_),
      };

      if (!isBlockedByMovement(candidate, staticColliders_)) {
        resolved = candidate;
        continue;
      }

      bool crossedCollider = false;
      for (const auto& collider : staticColliders_) {
        if (!collider.blocksMovement) {
          continue;
        }

        if (segmentIntersectsAabb2D(resolved.x, resolved.y, candidate.x,
                                    candidate.y, collider,
                                    kPlayerCollisionRadius)) {
          crossedCollider = true;
          break;
        }
      }

      if (!crossedCollider) {
        continue;
      }

      Vec2 slideX = {
          .x = std::clamp(resolved.x + stepX, worldMinX_, worldMaxX_),
          .y = resolved.y,
      };
      if (!isBlockedByMovement(slideX, staticColliders_)) {
        resolved = slideX;
        continue;
      }

      Vec2 slideY = {
          .x = resolved.x,
          .y = std::clamp(resolved.y + stepY, worldMinY_, worldMaxY_),
      };
      if (!isBlockedByMovement(slideY, staticColliders_)) {
        resolved = slideY;
        continue;
      }

      // 양축 모두 막힌 경우 해당 서브스텝 이동 중단.
      break;
    }

    resolveMovementPenetration(resolved, staticColliders_);
    player.position.x = std::clamp(resolved.x, worldMinX_, worldMaxX_);
    player.position.y = std::clamp(resolved.y, worldMinY_, worldMaxY_);
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
      if (lateral > kProjectileHitRadiusMeters) {
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
    if (!source.alive) {
      return;
    }

    applyDamageFromSource(source.playerId, source.teamId, target, damage,
                          skillSlot, critical);
  };

  auto movePlayerByDelta = [&](PlayerState& player, const Vec2& delta) {
    Vec2 resolved = player.position;
    Vec2 desired = {
        .x = std::clamp(resolved.x + delta.x, worldMinX_, worldMaxX_),
        .y = std::clamp(resolved.y + delta.y, worldMinY_, worldMaxY_),
    };

    if (!isBlockedByMovement(desired, staticColliders_)) {
      resolved = desired;
    } else {
      Vec2 slideX = {
          .x = std::clamp(resolved.x + delta.x, worldMinX_, worldMaxX_),
          .y = resolved.y,
      };
      if (!isBlockedByMovement(slideX, staticColliders_)) {
        resolved = slideX;
      }

      Vec2 slideY = {
          .x = resolved.x,
          .y = std::clamp(resolved.y + delta.y, worldMinY_, worldMaxY_),
      };
      if (!isBlockedByMovement(slideY, staticColliders_)) {
        resolved = slideY;
      }
    }

    resolveMovementPenetration(resolved, staticColliders_);
    player.position.x = std::clamp(resolved.x, worldMinX_, worldMaxX_);
    player.position.y = std::clamp(resolved.y, worldMinY_, worldMaxY_);
  };

  auto applyStatusEffect = [&](const PlayerState& source,
                               PlayerState& target,
                               StatusEffectKind kind,
                               std::uint32_t durationTicks,
                               float magnitude) {
    if (!source.alive || !target.alive || kind == StatusEffectKind::None ||
        durationTicks == 0 || !std::isfinite(magnitude)) {
      return;
    }

    float appliedMagnitude = std::max(0.0f, magnitude);
    if (kind == StatusEffectKind::Shield) {
      const auto requestedShield = static_cast<std::uint16_t>(std::clamp(
          appliedMagnitude, 0.0f,
          static_cast<float>(std::numeric_limits<std::uint16_t>::max())));
      const auto availableShield = static_cast<std::uint16_t>(
          std::numeric_limits<std::uint16_t>::max() - target.mShield);
      const auto grantedShield = std::min(requestedShield, availableShield);
      if (grantedShield == 0) {
        return;
      }

      target.mShield =
          static_cast<std::uint16_t>(target.mShield + grantedShield);
      appliedMagnitude = static_cast<float>(grantedShield);
    }

    if (kind == StatusEffectKind::Stun) {
      target.velocity = Vec2{};
      cancelPendingSkillCasts(target.playerId);
    }

    const std::uint32_t effectId = mNextStatusEffectId++;
    if (mNextStatusEffectId == 0) {
      mNextStatusEffectId = 1;
    }

    mPendingStatusEffectEvents.push_back(StatusEffectEvent{
        .mEffectId = effectId,
        .mSourcePlayerId = source.playerId,
        .mTargetPlayerId = target.playerId,
        .mKind = kind,
        .mPhase = StatusEffectPhase::Apply,
        .mDurationTicks = durationTicks,
        .mMagnitude = appliedMagnitude,
        .mServerTick = tick_,
    });

    mPendingStatusEffects.push_back(PendingStatusEffect{
        .mEffectId = effectId,
        .mSourcePlayerId = source.playerId,
        .mTargetPlayerId = target.playerId,
        .mKind = kind,
        .mExpireTick = tick_ + durationTicks,
        .mMagnitude = appliedMagnitude,
    });
  };

  auto executeSkill = [&](PlayerState& source, SkillSlot slot, float aimRadian) {
    if (!source.alive ||
        hasActiveStatusEffect(source.playerId, StatusEffectKind::Stun)) {
      return;
    }

    pendingCombatEvents_.push_back(CombatEvent{
        .type = CombatEventType::SkillCast,
        .sourcePlayerId = source.playerId,
        .targetPlayerId = 0,
        .skillSlot = slot,
        .damage = 0,
        .critical = false,
        .serverTick = tick_,
        .position = source.position,
        .mAimRadian = aimRadian,
    });

    const auto sourceRules = combatRuleForProfile(source.profileId);
    const Vec2 aimDirection = directionFromRadian(aimRadian);

    const bool isBrunoProfile = source.profileId == "bruno_bear" ||
                                source.profileId == "bruiser";
    const bool isCoralProfile = source.profileId == "coral_cat";

    if (isBrunoProfile) {
      if (slot == SkillSlot::Q) {
        const auto& rule = sourceRules.skillQ;
        const float dashDistance =
            std::clamp(rule.rangeMeters * 0.45f, 2.0f, 4.2f);
        movePlayerByDelta(source, Vec2{.x = aimDirection.x * dashDistance,
                                       .y = aimDirection.y * dashDistance});

        const float hitRadius =
            std::max(1.8f, rule.radiusMeters > 0.0f ? rule.radiusMeters : 2.6f);
        const float hitRadiusSq = hitRadius * hitRadius;

        float bestDistSq = std::numeric_limits<float>::max();
        PlayerState* bestTarget = nullptr;

        for (auto& [targetId, target] : players_) {
          if (targetId == source.playerId || !target.alive ||
              (source.teamId != 0 && target.teamId == source.teamId)) {
            continue;
          }

          const float d = distSq(source.position, target.position);
          if (d <= hitRadiusSq && d < bestDistSq) {
            bestDistSq = d;
            bestTarget = &target;
          }
        }

        if (bestTarget != nullptr) {
          pushDamageEvents(source, *bestTarget, rule.damage, SkillSlot::Q,
                           rule.critical);
          if (bestTarget->alive) {
            applyStatusEffect(
                source, *bestTarget, StatusEffectKind::Stun,
                durationTicksFromMilliseconds(350, tickRate_), 1.0f);
          }
        }
        return;
      }

      if (slot == SkillSlot::E) {
        const auto& rule = sourceRules.skillE;
        const float radius =
            std::max(2.2f, rule.radiusMeters > 0.0f ? rule.radiusMeters : 3.4f);
        const float radiusSq = radius * radius;

        source.reloading = false;
        source.reloadRemainingTicks = 0;

        const auto ammoBoost = std::max<std::uint16_t>(1, rule.ammoCost);
        source.ammo = std::min<std::uint16_t>(
            source.maxAmmo,
            static_cast<std::uint16_t>(source.ammo + ammoBoost));

        constexpr std::uint16_t kServerMaxHp = 100;
        const auto healAmount = std::max<std::uint16_t>(4, rule.damage / 2);
        source.hp = std::min<std::uint16_t>(
            kServerMaxHp,
            static_cast<std::uint16_t>(source.hp + healAmount));

        applyStatusEffect(source, source, StatusEffectKind::Shield,
                          durationTicksFromMilliseconds(4500, tickRate_),
                          22.0f);

        for (auto& [targetId, target] : players_) {
          if (targetId == source.playerId || !target.alive ||
              (source.teamId != 0 && target.teamId == source.teamId)) {
            continue;
          }

          if (distSq(source.position, target.position) <= radiusSq) {
            pushDamageEvents(source, target, rule.damage, SkillSlot::E,
                             rule.critical);
          }
        }
        return;
      }

      if (slot == SkillSlot::R) {
        const auto& rule = sourceRules.skillR;
        const float radius = std::max(3.8f, rule.radiusMeters);
        const float radiusSq = radius * radius;

        for (auto& [targetId, target] : players_) {
          if (targetId == source.playerId || !target.alive ||
              (source.teamId != 0 && target.teamId == source.teamId)) {
            continue;
          }

          if (distSq(source.position, target.position) <= radiusSq) {
            pushDamageEvents(source, target, rule.damage, SkillSlot::R,
                             rule.critical);
            if (target.alive) {
              applyStatusEffect(
                  source, target, StatusEffectKind::Stun,
                  durationTicksFromMilliseconds(1200, tickRate_), 1.0f);
            }
          }
        }
        return;
      }
    }

    if (isCoralProfile) {
      if (slot == SkillSlot::Q) {
        const auto& rule = sourceRules.skillQ;
        const float range = std::max(rule.rangeMeters, sourceRules.shotRangeMeters + 2.0f);

        if (auto* target = findShotTarget(source, range, aimRadian);
            target != nullptr) {
          pushDamageEvents(source, *target, rule.damage, SkillSlot::Q,
                           rule.critical);
        }
        return;
      }

      if (slot == SkillSlot::E) {
        const auto& rule = sourceRules.skillE;

        const float sign = ((tick_ + source.playerId) % 2 == 0) ? 1.0f : -1.0f;
        const Vec2 sideDirection = {
            .x = -aimDirection.y * sign,
            .y = aimDirection.x * sign,
        };

        const float dashDistance = std::clamp(rule.rangeMeters * 0.45f, 1.4f, 3.2f);
        movePlayerByDelta(source, Vec2{.x = sideDirection.x * dashDistance,
                                       .y = sideDirection.y * dashDistance});

        const float pokeRange =
            std::max(2.0f, rule.radiusMeters > 0.0f ? rule.radiusMeters : 2.4f);
        if (auto* target = findNearestTargetInRange(source, pokeRange);
            target != nullptr) {
          const std::uint16_t pokeDamage =
              std::max<std::uint16_t>(1, static_cast<std::uint16_t>(rule.damage / 2));
          pushDamageEvents(source, *target, pokeDamage, SkillSlot::E,
                           rule.critical);
          if (target->alive) {
            applyStatusEffect(
                source, *target, StatusEffectKind::Slow,
                durationTicksFromMilliseconds(2800, tickRate_), 0.22f);
          }
        }
        return;
      }

      if (slot == SkillSlot::R) {
        const auto& rule = sourceRules.skillR;
        const float range = std::max(8.0f, rule.rangeMeters);
        const float radius = std::max(2.6f, rule.radiusMeters);
        const float radiusSq = radius * radius;

        const Vec2 burstCenter = {
            .x = source.position.x + aimDirection.x * range,
            .y = source.position.y + aimDirection.y * range,
        };

        for (auto& [targetId, target] : players_) {
          if (targetId == source.playerId || !target.alive ||
              (source.teamId != 0 && target.teamId == source.teamId)) {
            continue;
          }

          if (distSq(burstCenter, target.position) <= radiusSq) {
            pushDamageEvents(source, target, rule.damage, SkillSlot::R,
                             rule.critical);
          }
        }
        return;
      }
    }

    // 기본 프로필 fallback
    if (slot == SkillSlot::Q) {
      const auto& rule = sourceRules.skillQ;
      if (auto* target = findNearestTargetInRange(source, rule.rangeMeters);
          target != nullptr) {
        pushDamageEvents(source, *target, rule.damage, SkillSlot::Q,
                         rule.critical);
      }
      return;
    }

    if (slot == SkillSlot::E) {
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
    if (hasActiveStatusEffect(player.playerId, StatusEffectKind::Stun)) {
      cancelPendingSkillCasts(player.playerId);
    }

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
    std::vector<PendingSkillCast> castsToProcess;
    castsToProcess.swap(pendingSkillCasts_);
    pendingSkillCasts_.reserve(castsToProcess.size());

    for (const auto& cast : castsToProcess) {
      auto sourceFound = players_.find(cast.sourcePlayerId);
      if (sourceFound == players_.end()) {
        continue;
      }

      auto& source = sourceFound->second;
      if (!source.alive ||
          hasActiveStatusEffect(source.playerId, StatusEffectKind::Stun)) {
        source.castingSkill = SkillSlot::None;
        source.castRemainingTicks = 0;
        continue;
      }

      if (cast.executeTick > tick_) {
        pendingSkillCasts_.push_back(cast);
        continue;
      }

      source.castingSkill = SkillSlot::None;
      source.castRemainingTicks = 0;
      executeSkill(source, cast.slot, cast.aimRadian);
    }
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
    const bool stunned =
        hasActiveStatusEffect(playerId, StatusEffectKind::Stun);
    bool actionLocked = player.castRemainingTicks > 0 || stunned;

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
          PendingProjectile pendingProjectile{
              .mProjectileId = projectileId,
              .mOwnerPlayerId = playerId,
              .mTargetPlayerId = 0,
              .mTerminalPhase = ProjectilePhase::Despawn,
              .mTerminalTick =
                  tick_ + projectileTravelTicks(rules.shotRangeMeters,
                                                rules.projectileSpeed, tickRate_),
              .mOriginPosition = player.position,
              .mTerminalPosition = Vec2{
                  .x = std::clamp(
                      player.position.x +
                          projectileDirection.x * rules.shotRangeMeters,
                      worldMinX_, worldMaxX_),
                  .y = std::clamp(
                      player.position.y +
                          projectileDirection.y * rules.shotRangeMeters,
                      worldMinY_, worldMaxY_),
              },
              .mVelocity = Vec2{
                  .x = projectileDirection.x * rules.projectileSpeed,
                  .y = projectileDirection.y * rules.projectileSpeed,
              },
              .mOwnerTeamId = player.teamId,
              .mDamage = rules.shotDamage,
              .mCritical = false,
          };

          if (auto* target =
                  findShotTarget(player, rules.shotRangeMeters, input.aimRadian);
              target != nullptr) {
            const float hitDistance = std::sqrt(distSq(player.position,
                                                       target->position));
            pendingProjectile.mTargetPlayerId = target->playerId;
            pendingProjectile.mTerminalPhase = ProjectilePhase::Hit;
            pendingProjectile.mTerminalTick =
                tick_ + projectileTravelTicks(hitDistance,
                                              rules.projectileSpeed, tickRate_);
            pendingProjectile.mTerminalPosition = target->position;
          }

          pendingProjectileEvents_.push_back(ProjectileEvent{
              .projectileId = projectileId,
              .ownerPlayerId = playerId,
              .targetPlayerId = pendingProjectile.mTargetPlayerId,
              .phase = ProjectilePhase::Spawn,
              .serverTick = tick_,
              .position = player.position,
              .velocity = pendingProjectile.mVelocity,
          });

          mPendingProjectiles.push_back(pendingProjectile);
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
        executeSkill(player, slot, input.aimRadian);
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

  snapshot.mActiveStatusEffects.reserve(mPendingStatusEffects.size());
  for (const auto& effect : mPendingStatusEffects) {
    if (effect.mExpireTick <= tick_) {
      continue;
    }

    snapshot.mActiveStatusEffects.push_back(StatusEffectEvent{
        .mEffectId = effect.mEffectId,
        .mSourcePlayerId = effect.mSourcePlayerId,
        .mTargetPlayerId = effect.mTargetPlayerId,
        .mKind = effect.mKind,
        .mPhase = StatusEffectPhase::Apply,
        .mDurationTicks = effect.mExpireTick - tick_,
        .mMagnitude = effect.mMagnitude,
        .mServerTick = tick_,
    });
  }

  return snapshot;
}

}  // namespace wildpaw::room
