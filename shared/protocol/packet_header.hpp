#pragma once

#include <cstdint>

namespace wildpaw::protocol {

#pragma pack(push, 1)
struct PacketHeader {
  std::uint16_t msgType;
  std::uint32_t roomId;
  std::uint32_t clientSeq;
  std::uint32_t ack;
  std::uint32_t ackBits;
  std::uint32_t serverTick;
};
#pragma pack(pop)

static_assert(sizeof(PacketHeader) == 22, "PacketHeader size mismatch");

}  // namespace wildpaw::protocol
