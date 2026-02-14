#pragma once

#include <cstdint>

namespace wildpaw::protocol {

enum class MessageType : std::uint16_t {
  // Client -> Server
  C2S_HELLO = 1,
  C2S_INPUT = 2,
  C2S_PING = 3,
  C2S_ACK = 4,

  // Server -> Client
  S2C_WELCOME = 101,
  S2C_MATCH_START = 102,
  S2C_SNAPSHOT_BASE = 103,
  S2C_SNAPSHOT_DELTA = 104,
  S2C_EVENT = 105,
  S2C_MATCH_END = 106,
};

}  // namespace wildpaw::protocol
