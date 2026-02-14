#include "room/wire_json.hpp"

#include <algorithm>
#include <charconv>
#include <cstddef>
#include <cstdlib>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>

namespace wildpaw::room::wire {
namespace {

std::optional<std::string_view> findFieldValue(std::string_view raw,
                                               std::string_view key) {
  const std::string needle = std::string{"\""} + std::string{key} + "\"";
  const std::size_t keyPos = raw.find(needle);
  if (keyPos == std::string_view::npos) {
    return std::nullopt;
  }

  const std::size_t colonPos = raw.find(':', keyPos + needle.size());
  if (colonPos == std::string_view::npos) {
    return std::nullopt;
  }

  std::size_t begin = colonPos + 1;
  while (begin < raw.size() &&
         (raw[begin] == ' ' || raw[begin] == '\t' || raw[begin] == '\n' ||
          raw[begin] == '\r')) {
    ++begin;
  }

  if (begin >= raw.size()) {
    return std::nullopt;
  }

  if (raw[begin] == '"') {
    const std::size_t valueBegin = begin + 1;
    const std::size_t valueEnd = raw.find('"', valueBegin);
    if (valueEnd == std::string_view::npos) {
      return std::nullopt;
    }
    return raw.substr(valueBegin, valueEnd - valueBegin);
  }

  const std::size_t valueBegin = begin;
  std::size_t valueEnd = valueBegin;
  while (valueEnd < raw.size() && raw[valueEnd] != ',' && raw[valueEnd] != '}' &&
         raw[valueEnd] != ']') {
    ++valueEnd;
  }

  auto value = raw.substr(valueBegin, valueEnd - valueBegin);
  while (!value.empty() &&
         (value.back() == ' ' || value.back() == '\t' || value.back() == '\n' ||
          value.back() == '\r')) {
    value.remove_suffix(1);
  }

  return value;
}

std::optional<std::uint32_t> parseUint32(std::string_view value) {
  std::uint32_t parsed = 0;
  const auto* begin = value.data();
  const auto* end = value.data() + value.size();
  const auto [ptr, ec] = std::from_chars(begin, end, parsed);
  if (ec != std::errc{} || ptr != end) {
    return std::nullopt;
  }
  return parsed;
}

std::optional<int> parseInt(std::string_view value) {
  int parsed = 0;
  const auto* begin = value.data();
  const auto* end = value.data() + value.size();
  const auto [ptr, ec] = std::from_chars(begin, end, parsed);
  if (ec != std::errc{} || ptr != end) {
    return std::nullopt;
  }
  return parsed;
}

std::optional<float> parseFloat(std::string_view value) {
  std::string copy{value};
  char* parseEnd = nullptr;
  const float parsed = std::strtof(copy.c_str(), &parseEnd);
  if (parseEnd == copy.c_str()) {
    return std::nullopt;
  }
  return parsed;
}

std::optional<bool> parseBool(std::string_view value) {
  if (value == "true" || value == "1") {
    return true;
  }
  if (value == "false" || value == "0") {
    return false;
  }
  return std::nullopt;
}

std::string boolToJson(bool value) {
  return value ? "true" : "false";
}

std::string encodePlayers(std::span<const PlayerState> players) {
  std::ostringstream oss;
  oss << '[';

  for (std::size_t i = 0; i < players.size(); ++i) {
    const auto& player = players[i];
    if (i > 0) {
      oss << ',';
    }

    oss << "{"
        << "\"playerId\":" << player.playerId << ','
        << "\"position\":{\"x\":" << player.position.x << ",\"y\":"
        << player.position.y << "},"
        << "\"velocity\":{\"x\":" << player.velocity.x << ",\"y\":"
        << player.velocity.y << "},"
        << "\"hp\":" << player.hp << ','
        << "\"alive\":" << boolToJson(player.alive) << ','
        << "\"lastProcessedInputSeq\":" << player.lastProcessedInputSeq << "}";
  }

  oss << ']';
  return oss.str();
}

std::string envelopePrefix(std::string_view type, const EnvelopeMeta& meta) {
  std::ostringstream oss;
  oss << "{\"seq\":" << meta.seq << ','
      << "\"ack\":" << meta.ack << ','
      << "\"ackBits\":" << meta.ackBits << ','
      << "\"t\":\"" << type << "\",\"d\":{";
  return oss.str();
}

}  // namespace

std::optional<std::string> extractEnvelopeType(std::string_view raw) {
  const auto maybeType = findFieldValue(raw, "t");
  if (!maybeType.has_value() || maybeType->empty()) {
    return std::nullopt;
  }
  return std::string{*maybeType};
}

std::optional<EnvelopeMeta> decodeEnvelopeMeta(std::string_view raw) {
  EnvelopeMeta meta;

  const auto seqRaw = findFieldValue(raw, "seq");
  if (!seqRaw.has_value()) {
    return std::nullopt;
  }

  const auto seq = parseUint32(*seqRaw);
  if (!seq.has_value()) {
    return std::nullopt;
  }

  meta.seq = *seq;

  const auto ackRaw = findFieldValue(raw, "ack");
  const auto ackBitsRaw = findFieldValue(raw, "ackBits");

  if (ackRaw.has_value()) {
    if (const auto ack = parseUint32(*ackRaw); ack.has_value()) {
      meta.ack = *ack;
    }
  }

  if (ackBitsRaw.has_value()) {
    if (const auto ackBits = parseUint32(*ackBitsRaw); ackBits.has_value()) {
      meta.ackBits = *ackBits;
    }
  }

  return meta;
}

std::optional<InputFrame> decodeInputEnvelope(std::string_view raw) {
  const auto maybeType = extractEnvelopeType(raw);
  if (!maybeType.has_value() || *maybeType != "C2S_INPUT") {
    return std::nullopt;
  }

  const auto inputSeqRaw = findFieldValue(raw, "inputSeq");
  const auto moveXRaw = findFieldValue(raw, "moveX");
  const auto moveYRaw = findFieldValue(raw, "moveY");
  const auto fireRaw = findFieldValue(raw, "fire");
  const auto aimRaw = findFieldValue(raw, "aimRadian");

  if (!inputSeqRaw.has_value() || !moveXRaw.has_value() || !moveYRaw.has_value() ||
      !fireRaw.has_value() || !aimRaw.has_value()) {
    return std::nullopt;
  }

  const auto inputSeq = parseUint32(*inputSeqRaw);
  const auto moveX = parseInt(*moveXRaw);
  const auto moveY = parseInt(*moveYRaw);
  const auto firing = parseBool(*fireRaw);
  const auto aimRadian = parseFloat(*aimRaw);

  if (!inputSeq.has_value() || !moveX.has_value() || !moveY.has_value() ||
      !firing.has_value() || !aimRadian.has_value()) {
    return std::nullopt;
  }

  InputFrame frame;
  frame.inputSeq = *inputSeq;
  frame.moveX = static_cast<std::int8_t>(std::clamp(*moveX, -1, 1));
  frame.moveY = static_cast<std::int8_t>(std::clamp(*moveY, -1, 1));
  frame.firing = *firing;
  frame.aimRadian = *aimRadian;
  return frame;
}

std::string encodeWelcome(std::uint32_t playerId,
                          std::uint32_t tickRate,
                          std::uint32_t serverTick,
                          const EnvelopeMeta& meta) {
  std::ostringstream oss;
  oss << envelopePrefix("S2C_WELCOME", meta)
      << "\"playerId\":" << playerId << ','
      << "\"serverTickRate\":" << tickRate << ','
      << "\"serverTick\":" << serverTick << "}}\n";
  return oss.str();
}

std::string encodeSnapshotBase(const WorldSnapshot& snapshot,
                               std::uint64_t serverTimeMs,
                               const EnvelopeMeta& meta) {
  std::ostringstream oss;
  oss << envelopePrefix("S2C_SNAPSHOT_BASE", meta)
      << "\"serverTick\":" << snapshot.serverTick << ','
      << "\"serverTimeMs\":" << serverTimeMs << ','
      << "\"players\":" << encodePlayers(snapshot.players)
      << "}}\n";
  return oss.str();
}

std::string encodeSnapshotDelta(const SnapshotDelta& delta,
                                std::uint64_t serverTimeMs,
                                std::span<const PlayerState> visiblePlayers,
                                const EnvelopeMeta& meta) {
  std::ostringstream oss;
  oss << envelopePrefix("S2C_SNAPSHOT_DELTA", meta)
      << "\"serverTick\":" << delta.serverTick << ','
      << "\"serverTimeMs\":" << serverTimeMs << ','
      << "\"players\":" << encodePlayers(visiblePlayers)
      << "}}\n";
  return oss.str();
}

std::string encodeEvent(std::string_view eventName,
                        std::string_view message,
                        const EnvelopeMeta& meta) {
  std::ostringstream oss;
  oss << envelopePrefix("S2C_EVENT", meta)
      << "\"name\":\"" << eventName << "\",";

  if (!message.empty()) {
    oss << "\"message\":\"" << message << "\"";
  } else {
    oss << "\"message\":\"\"";
  }

  oss << "}}\n";
  return oss.str();
}

}  // namespace wildpaw::room::wire
