#pragma once

#include <cstdint>

namespace wildpaw::room::wire {

struct EnvelopeMeta {
  std::uint32_t seq{0};
  std::uint32_t ack{0};
  std::uint32_t ackBits{0};
};

}  // namespace wildpaw::room::wire
