#pragma once

#include <cstdint>
#include <deque>
#include <optional>
#include <unordered_map>
#include <vector>

namespace wildpaw::room {

struct InputFrame {
  std::uint32_t inputSeq{0};
  std::int8_t moveX{0};   // -1, 0, 1
  std::int8_t moveY{0};   // -1, 0, 1
  bool firing{false};
  float aimRadian{0.0f};
};

class InputBuffer {
 public:
  explicit InputBuffer(std::size_t maxFramesPerPlayer = 256);

  void push(std::uint32_t playerId, const InputFrame& frame);
  std::vector<InputFrame> popUpTo(std::uint32_t playerId, std::uint32_t maxSeq);
  std::optional<InputFrame> latest(std::uint32_t playerId) const;

 private:
  std::size_t maxFramesPerPlayer_;
  std::unordered_map<std::uint32_t, std::deque<InputFrame>> buffers_;
};

}  // namespace wildpaw::room
