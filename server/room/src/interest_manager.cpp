#include "room/interest_manager.hpp"

namespace wildpaw::room {

std::vector<PlayerState> InterestManager::filterFor(
    std::uint32_t viewerId,
    const std::vector<PlayerState>& players,
    float radiusMeters) const {
  std::vector<PlayerState> result;
  const float radiusSq = radiusMeters * radiusMeters;

  const PlayerState* viewer = nullptr;
  for (const auto& player : players) {
    if (player.playerId == viewerId) {
      viewer = &player;
      break;
    }
  }

  if (viewer == nullptr) {
    return result;
  }

  for (const auto& player : players) {
    const float dx = player.position.x - viewer->position.x;
    const float dy = player.position.y - viewer->position.y;
    const float distSq = dx * dx + dy * dy;

    if (player.playerId == viewerId || distSq <= radiusSq) {
      result.push_back(player);
    }
  }

  return result;
}

}  // namespace wildpaw::room
