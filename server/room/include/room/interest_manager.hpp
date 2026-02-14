#pragma once

#include <cstdint>
#include <unordered_map>
#include <vector>

#include "room/room_simulation.hpp"

namespace wildpaw::room {

class InterestManager {
 public:
  // 프레임 단위로 월드 플레이어 셀 인덱스를 재구성.
  void rebuild(const std::vector<PlayerState>& players,
               float cellSizeMeters = 8.0f);

  // rebuild() 이후 호출.
  std::vector<PlayerState> filterFor(std::uint32_t viewerId,
                                     float radiusMeters = 20.0f) const;

  // 호환용: 내부에서 rebuild + filter 수행.
  std::vector<PlayerState> filterFor(std::uint32_t viewerId,
                                     const std::vector<PlayerState>& players,
                                     float radiusMeters = 20.0f);

 private:
  using CellKey = std::int64_t;

  static CellKey makeCellKey(std::int32_t x, std::int32_t y);

  float cellSizeMeters_{8.0f};
  std::unordered_map<CellKey, std::vector<const PlayerState*>> grid_;
  std::unordered_map<std::uint32_t, const PlayerState*> playersById_;
};

}  // namespace wildpaw::room
