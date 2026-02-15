#pragma once

#include <cstdint>
#include <string>
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

struct PlayerState {
  std::uint32_t playerId{0};
  Vec2 position{};
  Vec2 velocity{};
  std::uint16_t hp{100};
  bool alive{true};
  std::uint32_t lastProcessedInputSeq{0};

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

struct WorldSnapshot {
  std::uint32_t serverTick{0};
  std::vector<PlayerState> players;
};

class RoomSimulation {
 public:
  explicit RoomSimulation(std::uint32_t tickRate = 30);

  void addPlayer(std::uint32_t playerId);
  void removePlayer(std::uint32_t playerId);
  void pushInput(std::uint32_t playerId, const InputFrame& frame);

  WorldSnapshot tick();
  [[nodiscard]] WorldSnapshot snapshot() const;

  std::vector<CombatEvent> drainCombatEvents();
  std::vector<ProjectileEvent> drainProjectileEvents();

  [[nodiscard]] std::uint32_t tickRate() const { return tickRate_; }
  [[nodiscard]] std::uint32_t currentTick() const { return tick_; }

 private:
  struct PendingSkillCast {
    std::uint32_t sourcePlayerId{0};
    SkillSlot slot{SkillSlot::None};
    std::uint32_t executeTick{0};
    float aimRadian{0.0f};
  };

  void collectInputs();
  void applyMovement();
  void processCombat();
  WorldSnapshot collectSnapshot() const;

  std::uint32_t tickRate_{30};
  std::uint32_t tick_{0};
  std::uint32_t nextProjectileId_{1};

  InputBuffer inputBuffer_;
  std::unordered_map<std::uint32_t, PlayerState> players_;
  std::unordered_map<std::uint32_t, InputFrame> frameInputs_;
  std::unordered_map<std::uint32_t, InputFrame> previousFrameInputs_;
  std::unordered_map<std::uint32_t, std::uint32_t> lastFireTick_;

  std::vector<PendingSkillCast> pendingSkillCasts_;
  std::vector<CombatEvent> pendingCombatEvents_;
  std::vector<ProjectileEvent> pendingProjectileEvents_;
};

}  // namespace wildpaw::room
