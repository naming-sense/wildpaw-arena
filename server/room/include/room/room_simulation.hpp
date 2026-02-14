#pragma once

#include <cstdint>
#include <unordered_map>
#include <vector>

#include "room/input_buffer.hpp"

namespace wildpaw::room {

struct Vec2 {
  float x{0.0f};
  float y{0.0f};
};

struct PlayerState {
  std::uint32_t playerId{0};
  Vec2 position{};
  Vec2 velocity{};
  std::uint16_t hp{100};
  bool alive{true};
  std::uint32_t lastProcessedInputSeq{0};
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

  [[nodiscard]] std::uint32_t tickRate() const { return tickRate_; }
  [[nodiscard]] std::uint32_t currentTick() const { return tick_; }

 private:
  void collectInputs();
  void applyMovement();
  void processCombat();
  WorldSnapshot collectSnapshot() const;

  std::uint32_t tickRate_{30};
  std::uint32_t tick_{0};

  InputBuffer inputBuffer_;
  std::unordered_map<std::uint32_t, PlayerState> players_;
  std::unordered_map<std::uint32_t, InputFrame> frameInputs_;
};

}  // namespace wildpaw::room
