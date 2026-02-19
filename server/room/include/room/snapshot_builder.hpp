#pragma once

#include <cstdint>
#include <unordered_map>
#include <vector>

#include "room/room_simulation.hpp"

namespace wildpaw::room {

struct SnapshotDelta {
  std::uint32_t serverTick{0};
  std::vector<PlayerState> changedPlayers;
  std::vector<std::uint32_t> removedPlayerIds;
};

class SnapshotBuilder {
 public:
  SnapshotDelta buildDelta(const WorldSnapshot& snapshot);

 private:
  std::unordered_map<std::uint32_t, PlayerState> lastPlayers_;
};

}  // namespace wildpaw::room
