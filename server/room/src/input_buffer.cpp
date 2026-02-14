#include "room/input_buffer.hpp"

#include <algorithm>

namespace wildpaw::room {

InputBuffer::InputBuffer(std::size_t maxFramesPerPlayer)
    : maxFramesPerPlayer_(maxFramesPerPlayer) {}

void InputBuffer::push(std::uint32_t playerId, const InputFrame& frame) {
  auto& queue = buffers_[playerId];

  auto it = std::lower_bound(
      queue.begin(), queue.end(), frame.inputSeq,
      [](const InputFrame& lhs, std::uint32_t seq) {
        return lhs.inputSeq < seq;
      });

  if (it == queue.end() || it->inputSeq != frame.inputSeq) {
    queue.insert(it, frame);
  }

  while (queue.size() > maxFramesPerPlayer_) {
    queue.pop_front();
  }
}

std::vector<InputFrame> InputBuffer::popUpTo(std::uint32_t playerId,
                                              std::uint32_t maxSeq) {
  std::vector<InputFrame> out;
  auto found = buffers_.find(playerId);
  if (found == buffers_.end()) {
    return out;
  }

  auto& queue = found->second;
  while (!queue.empty() && queue.front().inputSeq <= maxSeq) {
    out.push_back(queue.front());
    queue.pop_front();
  }

  return out;
}

std::optional<InputFrame> InputBuffer::latest(std::uint32_t playerId) const {
  auto found = buffers_.find(playerId);
  if (found == buffers_.end() || found->second.empty()) {
    return std::nullopt;
  }

  return found->second.back();
}

}  // namespace wildpaw::room
