#pragma once

#include <cstdint>
#include <vector>

#include "room/room_simulation.hpp"

namespace wildpaw::room {

class InterestManager {
 public:
  std::vector<PlayerState> filterFor(
      std::uint32_t viewerId,
      const std::vector<PlayerState>& players,
      float radiusMeters = 20.0f) const;
};

}  // namespace wildpaw::room
