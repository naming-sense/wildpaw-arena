#include "room/snapshot_builder.hpp"

#include <cmath>
#include <unordered_set>

namespace wildpaw::room {

namespace {
bool changedEnough(const PlayerState& a, const PlayerState& b) {
  constexpr float kPosEpsilon = 0.001f;
  constexpr float kVelEpsilon = 0.001f;

  auto diff2 = [](float x, float y) {
    const float d = x - y;
    return d * d;
  };

  const float posDistSq = diff2(a.position.x, b.position.x) + diff2(a.position.y, b.position.y);
  const float velDistSq = diff2(a.velocity.x, b.velocity.x) + diff2(a.velocity.y, b.velocity.y);

  return posDistSq > kPosEpsilon || velDistSq > kVelEpsilon ||
         a.hp != b.hp || a.alive != b.alive ||
         a.lastProcessedInputSeq != b.lastProcessedInputSeq ||
         a.ammo != b.ammo || a.maxAmmo != b.maxAmmo ||
         a.reloading != b.reloading ||
         a.reloadRemainingTicks != b.reloadRemainingTicks ||
         a.skillQCooldownTicks != b.skillQCooldownTicks ||
         a.skillECooldownTicks != b.skillECooldownTicks ||
         a.skillRCooldownTicks != b.skillRCooldownTicks ||
         a.castingSkill != b.castingSkill ||
         a.castRemainingTicks != b.castRemainingTicks;
}
}  // namespace

SnapshotDelta SnapshotBuilder::buildDelta(const WorldSnapshot& snapshot) {
  SnapshotDelta delta;
  delta.serverTick = snapshot.serverTick;

  std::unordered_set<std::uint32_t> currentPlayerIds;
  currentPlayerIds.reserve(snapshot.players.size());

  for (const auto& player : snapshot.players) {
    currentPlayerIds.insert(player.playerId);

    auto found = lastPlayers_.find(player.playerId);
    if (found == lastPlayers_.end() || changedEnough(found->second, player)) {
      delta.changedPlayers.push_back(player);
    }
  }

  for (const auto& [playerId, _] : lastPlayers_) {
    if (!currentPlayerIds.contains(playerId)) {
      delta.removedPlayerIds.push_back(playerId);
    }
  }

  lastPlayers_.clear();
  for (const auto& player : snapshot.players) {
    lastPlayers_[player.playerId] = player;
  }

  return delta;
}

}  // namespace wildpaw::room
