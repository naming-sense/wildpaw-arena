#include "room/interest_manager.hpp"

#include <algorithm>
#include <cmath>

namespace wildpaw::room {

InterestManager::CellKey InterestManager::makeCellKey(std::int32_t x,
                                                      std::int32_t y) {
  return (static_cast<std::int64_t>(x) << 32) |
         static_cast<std::uint32_t>(y);
}

void InterestManager::rebuild(const std::vector<PlayerState>& players,
                              float cellSizeMeters) {
  cellSizeMeters_ = std::max(1.0f, cellSizeMeters);
  grid_.clear();
  playersById_.clear();

  grid_.reserve(players.size() * 2);
  playersById_.reserve(players.size());

  for (const auto& player : players) {
    const auto cellX =
        static_cast<std::int32_t>(std::floor(player.position.x / cellSizeMeters_));
    const auto cellY =
        static_cast<std::int32_t>(std::floor(player.position.y / cellSizeMeters_));

    grid_[makeCellKey(cellX, cellY)].push_back(&player);
    playersById_[player.playerId] = &player;
  }
}

std::vector<PlayerState> InterestManager::filterFor(std::uint32_t viewerId,
                                                     float radiusMeters) const {
  std::vector<PlayerState> result;

  const auto viewerIt = playersById_.find(viewerId);
  if (viewerIt == playersById_.end()) {
    return result;
  }

  const auto* viewer = viewerIt->second;
  const float radius = std::max(0.1f, radiusMeters);
  const float radiusSq = radius * radius;

  const auto viewerCellX =
      static_cast<std::int32_t>(std::floor(viewer->position.x / cellSizeMeters_));
  const auto viewerCellY =
      static_cast<std::int32_t>(std::floor(viewer->position.y / cellSizeMeters_));

  const auto cellRange =
      static_cast<std::int32_t>(std::ceil(radius / cellSizeMeters_));

  for (std::int32_t y = viewerCellY - cellRange; y <= viewerCellY + cellRange;
       ++y) {
    for (std::int32_t x = viewerCellX - cellRange; x <= viewerCellX + cellRange;
         ++x) {
      const auto found = grid_.find(makeCellKey(x, y));
      if (found == grid_.end()) {
        continue;
      }

      for (const auto* candidate : found->second) {
        const float dx = candidate->position.x - viewer->position.x;
        const float dy = candidate->position.y - viewer->position.y;
        const float distSq = dx * dx + dy * dy;

        if (candidate->playerId == viewerId || distSq <= radiusSq) {
          result.push_back(*candidate);
        }
      }
    }
  }

  return result;
}

std::vector<PlayerState> InterestManager::filterFor(
    std::uint32_t viewerId,
    const std::vector<PlayerState>& players,
    float radiusMeters) {
  rebuild(players);
  return filterFor(viewerId, radiusMeters);
}

}  // namespace wildpaw::room
