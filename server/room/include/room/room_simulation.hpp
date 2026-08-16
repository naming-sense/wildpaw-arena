#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "room/input_buffer.hpp"

namespace wildpaw::room {

struct Vec2 {
  float x{0.0f};
  float y{0.0f};
};

enum class SkillSlot : std::uint8_t {
  None = 0,
  Q,
  E,
  R,
};

enum class CombatEventType : std::uint8_t {
  ShotFired = 0,
  SkillCast,
  DamageApplied,
  Knockout,
};

enum class ProjectilePhase : std::uint8_t {
  Spawn = 0,
  Hit,
  Despawn,
};

enum class StatusEffectKind : std::uint8_t {
  None = 0,
  Slow,
  Stun,
  Shield,
};

enum class StatusEffectPhase : std::uint8_t {
  Apply = 0,
  Remove,
};

struct PlayerState {
  std::uint32_t playerId{0};
  Vec2 position{};
  Vec2 velocity{};
  float mAimRadian{0.0f};
  std::uint16_t hp{100};
  std::uint16_t mShield{0};
  bool alive{true};
  std::uint32_t lastProcessedInputSeq{0};

  std::uint8_t teamId{0};
  std::uint16_t teamSlot{0};

  // 클라이언트가 선택한 실제 히어로 id(스냅샷 전송용)
  std::string mHeroId{"iris_wolf"};

  // 플레이어 룰 프로필 id(서버 내부용)
  std::string profileId{"ranger"};

  // 무기/스킬 상태 (클라 HUD 동기화용)
  std::uint16_t ammo{0};
  std::uint16_t maxAmmo{0};
  bool reloading{false};
  std::uint32_t reloadRemainingTicks{0};

  std::uint32_t skillQCooldownTicks{0};
  std::uint32_t skillECooldownTicks{0};
  std::uint32_t skillRCooldownTicks{0};

  SkillSlot castingSkill{SkillSlot::None};
  std::uint32_t castRemainingTicks{0};
};

struct CombatEvent {
  CombatEventType type{CombatEventType::ShotFired};
  std::uint32_t sourcePlayerId{0};
  std::uint32_t targetPlayerId{0};
  SkillSlot skillSlot{SkillSlot::None};
  std::uint16_t damage{0};
  bool critical{false};
  std::uint32_t serverTick{0};
  Vec2 position{};
  float mAimRadian{0.0f};
};

struct ProjectileEvent {
  std::uint32_t projectileId{0};
  std::uint32_t ownerPlayerId{0};
  std::uint32_t targetPlayerId{0};
  ProjectilePhase phase{ProjectilePhase::Spawn};
  std::uint32_t serverTick{0};
  Vec2 position{};
  Vec2 velocity{};
};

struct StatusEffectEvent {
  std::uint32_t mEffectId{0};
  std::uint32_t mSourcePlayerId{0};
  std::uint32_t mTargetPlayerId{0};
  StatusEffectKind mKind{StatusEffectKind::None};
  StatusEffectPhase mPhase{StatusEffectPhase::Apply};
  std::uint32_t mDurationTicks{0};
  float mMagnitude{0.0f};
  std::uint32_t mServerTick{0};
};

struct WorldSnapshot {
  std::uint32_t serverTick{0};
  std::vector<PlayerState> players;
  std::vector<StatusEffectEvent> mActiveStatusEffects;
};

struct StaticCollider {
  float minX{0.0f};
  float maxX{0.0f};
  float minY{0.0f};
  float maxY{0.0f};
  bool blocksMovement{false};
  bool blocksProjectile{false};
  bool blocksLineOfSight{false};
};

struct TeamSpawnPoint {
  std::uint8_t mTeamId{0};
  Vec2 mPosition{};
  float mRadius{0.0f};
  std::uint32_t mPhase{0};
};

class RoomSimulation {
 public:
  explicit RoomSimulation(std::uint32_t tickRate = 30);

  void addPlayer(std::uint32_t playerId,
                 std::uint8_t teamId = 0,
                 std::uint16_t teamSlot = 0);
  void removePlayer(std::uint32_t playerId);
  void pushInput(std::uint32_t playerId, const InputFrame& frame);
  bool setPlayerProfile(std::uint32_t playerId, std::string_view profileId);

  void setMapBounds(float minX, float maxX, float minY, float maxY);
  void setStaticColliders(std::vector<StaticCollider> colliders);
  void setTeamSpawnPoints(std::vector<TeamSpawnPoint> spawnPoints);

  WorldSnapshot tick();
  [[nodiscard]] WorldSnapshot snapshot() const;

  std::vector<CombatEvent> drainCombatEvents();
  std::vector<ProjectileEvent> drainProjectileEvents();
  std::vector<StatusEffectEvent> drainStatusEffectEvents();

  [[nodiscard]] std::uint32_t tickRate() const { return tickRate_; }
  [[nodiscard]] std::uint32_t currentTick() const { return tick_; }

 private:
  struct PendingSkillCast {
    std::uint32_t sourcePlayerId{0};
    SkillSlot slot{SkillSlot::None};
    std::uint32_t executeTick{0};
    float aimRadian{0.0f};
  };

  struct PendingProjectile {
    std::uint32_t mProjectileId{0};
    std::uint32_t mOwnerPlayerId{0};
    std::uint32_t mTargetPlayerId{0};
    ProjectilePhase mTerminalPhase{ProjectilePhase::Despawn};
    std::uint32_t mTerminalTick{0};
    Vec2 mOriginPosition{};
    Vec2 mTerminalPosition{};
    Vec2 mVelocity{};
    std::uint8_t mOwnerTeamId{0};
    std::uint16_t mDamage{0};
    bool mCritical{false};
  };

  struct PendingStatusEffect {
    std::uint32_t mEffectId{0};
    std::uint32_t mSourcePlayerId{0};
    std::uint32_t mTargetPlayerId{0};
    StatusEffectKind mKind{StatusEffectKind::None};
    std::uint32_t mExpireTick{0};
    float mMagnitude{0.0f};
  };

  void collectInputs();
  void applyMovement();
  void applyDamageFromSource(std::uint32_t sourcePlayerId,
                             std::uint8_t sourceTeamId,
                             PlayerState& target,
                             std::uint16_t damage,
                             SkillSlot skillSlot,
                             bool critical);
  [[nodiscard]] bool hasActiveStatusEffect(
      std::uint32_t playerId, StatusEffectKind kind) const;
  [[nodiscard]] float activeStatusEffectMagnitude(
      std::uint32_t playerId, StatusEffectKind kind) const;
  void cancelPendingSkillCasts(std::uint32_t playerId);
  void removeStatusEffectsForPlayer(std::uint32_t playerId,
                                    bool emitRemoveEvents);
  void processProjectileLifecycle();
  void processStatusEffectLifecycle();
  void processCombat();
  WorldSnapshot collectSnapshot() const;
  [[nodiscard]] std::optional<Vec2> resolveTeamSpawn(
      std::uint8_t teamId, std::uint16_t teamSlot) const;

  std::uint32_t tickRate_{30};
  std::uint32_t tick_{0};
  std::uint32_t nextProjectileId_{1};
  std::uint32_t mNextStatusEffectId{1};

  float worldMinX_{-50.0f};
  float worldMaxX_{50.0f};
  float worldMinY_{-50.0f};
  float worldMaxY_{50.0f};
  std::vector<StaticCollider> staticColliders_;
  std::vector<TeamSpawnPoint> mTeamSpawnPoints;

  InputBuffer inputBuffer_;
  std::unordered_map<std::uint32_t, PlayerState> players_;
  std::unordered_map<std::uint32_t, InputFrame> frameInputs_;
  std::unordered_map<std::uint32_t, InputFrame> previousFrameInputs_;
  std::unordered_map<std::uint32_t, std::uint32_t> lastFireTick_;

  std::vector<PendingSkillCast> pendingSkillCasts_;
  std::vector<PendingProjectile> mPendingProjectiles;
  std::vector<PendingStatusEffect> mPendingStatusEffects;
  std::vector<CombatEvent> pendingCombatEvents_;
  std::vector<ProjectileEvent> pendingProjectileEvents_;
  std::vector<StatusEffectEvent> mPendingStatusEffectEvents;
};

}  // namespace wildpaw::room
