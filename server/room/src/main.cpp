#include <boost/asio.hpp>
#include <boost/beast.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/websocket.hpp>
#include <boost/property_tree/json_parser.hpp>
#include <boost/property_tree/ptree.hpp>

#include <algorithm>
#include <atomic>
#include <charconv>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "room/combat_rule_table.hpp"
#include "room/interest_manager.hpp"
#include "room/room_session.hpp"
#include "room/room_simulation.hpp"
#include "room/snapshot_builder.hpp"
#include "room/wire_flatbuffers.hpp"

namespace beast = boost::beast;
namespace websocket = beast::websocket;
namespace http = beast::http;
namespace net = boost::asio;
using tcp = net::ip::tcp;

namespace {

std::uint64_t unixTimeMs() {
  using namespace std::chrono;
  return static_cast<std::uint64_t>(
      duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

constexpr std::uint16_t normalizeTeamSize(std::uint16_t teamSize) {
  return teamSize == 0 ? 1 : teamSize;
}

std::string jsonEscape(std::string_view input) {
  std::string out;
  out.reserve(input.size() + 8);

  auto hex = [](std::uint8_t value) {
    constexpr char kHex[] = "0123456789abcdef";
    std::string s;
    s.push_back(kHex[(value >> 4) & 0xF]);
    s.push_back(kHex[value & 0xF]);
    return s;
  };

  for (const unsigned char c : input) {
    switch (c) {
      case '\\':
        out += "\\\\";
        break;
      case '"':
        out += "\\\"";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (c < 0x20) {
          out += "\\u00";
          out += hex(c);
        } else {
          out.push_back(static_cast<char>(c));
        }
        break;
    }
  }

  return out;
}

std::string_view stripQuery(std::string_view target,
                            std::string_view* queryOut = nullptr) {
  const auto pos = target.find('?');
  if (pos == std::string_view::npos) {
    if (queryOut != nullptr) {
      *queryOut = {};
    }
    return target;
  }

  if (queryOut != nullptr) {
    *queryOut = target.substr(pos + 1);
  }

  return target.substr(0, pos);
}

std::optional<std::string> getQueryParam(std::string_view query,
                                        std::string_view key) {
  if (query.empty() || key.empty()) {
    return std::nullopt;
  }

  std::size_t start = 0;
  while (start < query.size()) {
    const auto amp = query.find('&', start);
    const auto end = amp == std::string_view::npos ? query.size() : amp;
    const auto eq = query.find('=', start);

    if (eq != std::string_view::npos && eq < end) {
      const auto k = query.substr(start, eq - start);
      const auto v = query.substr(eq + 1, end - (eq + 1));
      if (k == key) {
        return std::string{v};
      }
    }

    start = end + 1;
  }

  return std::nullopt;
}

std::unordered_set<std::uint32_t> makeVisibleIdSet(
    const std::vector<wildpaw::room::PlayerState>& visiblePlayers) {
  std::unordered_set<std::uint32_t> visibleIds;
  visibleIds.reserve(visiblePlayers.size());
  for (const auto& player : visiblePlayers) {
    visibleIds.insert(player.playerId);
  }
  return visibleIds;
}

std::vector<wildpaw::room::PlayerState> selectVisibleChangedPlayers(
    const wildpaw::room::SnapshotDelta& delta,
    const std::unordered_set<std::uint32_t>& visibleIds) {
  if (delta.changedPlayers.empty() || visibleIds.empty()) {
    return {};
  }

  std::vector<wildpaw::room::PlayerState> filtered;
  filtered.reserve(delta.changedPlayers.size());
  for (const auto& player : delta.changedPlayers) {
    if (visibleIds.contains(player.playerId)) {
      filtered.push_back(player);
    }
  }

  return filtered;
}

bool shouldSendCombatEvent(std::uint32_t viewerId,
                           const std::unordered_set<std::uint32_t>& visibleIds,
                           const wildpaw::room::CombatEvent& event) {
  if (viewerId == event.sourcePlayerId || viewerId == event.targetPlayerId) {
    return true;
  }

  if (visibleIds.contains(event.sourcePlayerId)) {
    return true;
  }

  if (event.targetPlayerId != 0 && visibleIds.contains(event.targetPlayerId)) {
    return true;
  }

  return false;
}

bool shouldSendProjectileEvent(
    std::uint32_t viewerId,
    const std::unordered_set<std::uint32_t>& visibleIds,
    const wildpaw::room::ProjectileEvent& event) {
  if (viewerId == event.ownerPlayerId || viewerId == event.targetPlayerId) {
    return true;
  }

  if (visibleIds.contains(event.ownerPlayerId)) {
    return true;
  }

  if (event.targetPlayerId != 0 && visibleIds.contains(event.targetPlayerId)) {
    return true;
  }

  return false;
}

std::uint32_t fnv1a32(std::string_view input) {
  std::uint32_t hash = 2166136261u;
  for (const unsigned char ch : input) {
    hash ^= static_cast<std::uint32_t>(ch);
    hash *= 16777619u;
  }
  return hash;
}

std::string toHex8(std::uint32_t value) {
  constexpr char kHex[] = "0123456789abcdef";
  std::string out(8, '0');
  for (int i = 7; i >= 0; --i) {
    out[static_cast<std::size_t>(i)] = kHex[value & 0x0Fu];
    value >>= 4;
  }
  return out;
}

std::string toLowerAscii(std::string input) {
  for (char& ch : input) {
    ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
  }
  return input;
}

std::string signRoomToken(std::string_view matchId,
                          std::string_view mapId,
                          std::uint64_t expiresAtMs,
                          std::string_view secret) {
  std::ostringstream payload;
  payload << matchId << ':' << mapId << ':' << expiresAtMs << ':' << secret;
  return toHex8(fnv1a32(payload.str()));
}

struct ParsedRoomToken {
  bool ok{false};
  std::string error;
  std::string matchId;
  std::string mapId;
  std::uint64_t expiresAtMs{0};
};

ParsedRoomToken parseRoomToken(std::string_view token,
                               std::string_view tokenSecret,
                               std::uint64_t nowMs) {
  ParsedRoomToken parsed;

  constexpr std::string_view kPrefix = "rt1:";
  if (!token.starts_with(kPrefix)) {
    if (token == "dev-room") {
      parsed.ok = true;
      parsed.matchId = "dev-room";
      parsed.mapId = "NJD_CR_01";
      parsed.expiresAtMs = nowMs + 24ull * 60ull * 60ull * 1000ull;
      return parsed;
    }

    parsed.error = "invalid token version";
    return parsed;
  }

  const auto firstSep = token.find(':');
  const auto secondSep = token.find(':', firstSep + 1);
  const auto thirdSep = token.find(':', secondSep + 1);
  const auto fourthSep = token.find(':', thirdSep + 1);

  if (firstSep == std::string_view::npos ||
      secondSep == std::string_view::npos ||
      thirdSep == std::string_view::npos ||
      fourthSep == std::string_view::npos) {
    parsed.error = "invalid token format";
    return parsed;
  }

  parsed.matchId = std::string{token.substr(firstSep + 1, secondSep - firstSep - 1)};
  parsed.mapId = std::string{token.substr(secondSep + 1, thirdSep - secondSep - 1)};

  const auto expiresView = token.substr(thirdSep + 1, fourthSep - thirdSep - 1);
  const auto sigView = token.substr(fourthSep + 1);

  if (parsed.matchId.empty() || parsed.mapId.empty() || expiresView.empty() ||
      sigView.empty()) {
    parsed.error = "missing token fields";
    return parsed;
  }

  std::uint64_t expiresAtMs = 0;
  {
    const auto* begin = expiresView.data();
    const auto* end = expiresView.data() + expiresView.size();
    const auto [ptr, ec] = std::from_chars(begin, end, expiresAtMs);
    if (ec != std::errc{} || ptr != end) {
      parsed.error = "invalid token expiry";
      return parsed;
    }
  }

  if (expiresAtMs <= nowMs) {
    parsed.error = "token expired";
    return parsed;
  }

  const auto expectedSig = signRoomToken(parsed.matchId, parsed.mapId,
                                         expiresAtMs, tokenSecret);
  if (sigView != expectedSig) {
    parsed.error = "token signature mismatch";
    return parsed;
  }

  parsed.ok = true;
  parsed.expiresAtMs = expiresAtMs;
  return parsed;
}

bool isSoloPracticeMatchId(std::string_view matchId) {
  return matchId.starts_with("solo_") || matchId == "solo_practice" ||
         matchId == "solo_test";
}

struct PrefabRuntimeSpec {
  float sizeX{0.0f};
  float sizeY{0.0f};
  bool blocksMovement{false};
  bool blocksProjectile{false};
  bool blocksLineOfSight{false};
};

const std::unordered_map<std::string, PrefabRuntimeSpec>& prefabSpecs() {
  static const std::unordered_map<std::string, PrefabRuntimeSpec> kSpecs = {
      {"COV_L_2x1", PrefabRuntimeSpec{2.0f, 1.0f, true, true, false}},
      {"COV_H_3x1", PrefabRuntimeSpec{3.0f, 1.0f, true, true, true}},
      {"WALL_6", PrefabRuntimeSpec{6.0f, 0.8f, true, true, true}},
      {"BUSH_S", PrefabRuntimeSpec{3.0f, 3.0f, false, false, false}},
      {"BUSH_M", PrefabRuntimeSpec{5.0f, 5.0f, false, false, false}},
      {"BUSH_L", PrefabRuntimeSpec{7.0f, 7.0f, false, false, false}},
      {"RAMP_10", PrefabRuntimeSpec{2.8f, 10.0f, false, false, false}},
      {"PAD_JUMP", PrefabRuntimeSpec{2.0f, 2.0f, false, false, false}},
      {"OBJ_CORE", PrefabRuntimeSpec{4.0f, 4.0f, false, false, false}},
      {"OBJ_ZONE", PrefabRuntimeSpec{9.0f, 9.0f, false, false, false}},
      {"OBJ_PAYLOAD_PATH", PrefabRuntimeSpec{1.0f, 1.0f, false, false, false}},
  };

  return kSpecs;
}

wildpaw::room::StaticCollider createRuntimeCollider(float centerX,
                                                     float centerY,
                                                     float sizeX,
                                                     float sizeY,
                                                     float rotDeg,
                                                     bool blocksMovement,
                                                     bool blocksProjectile,
                                                     bool blocksLineOfSight) {
  const float halfX = std::max(0.01f, sizeX * 0.5f);
  const float halfY = std::max(0.01f, sizeY * 0.5f);

  const float theta = rotDeg * 3.1415926535f / 180.0f;
  const float cosT = std::cos(theta);
  const float sinT = std::sin(theta);

  const float extentX = std::abs(cosT) * halfX + std::abs(sinT) * halfY;
  const float extentY = std::abs(sinT) * halfX + std::abs(cosT) * halfY;

  return wildpaw::room::StaticCollider{
      .minX = centerX - extentX,
      .maxX = centerX + extentX,
      .minY = centerY - extentY,
      .maxY = centerY + extentY,
      .blocksMovement = blocksMovement,
      .blocksProjectile = blocksProjectile,
      .blocksLineOfSight = blocksLineOfSight,
  };
}

struct LoadedMapRuntimeConfig {
  float minX{-50.0f};
  float maxX{50.0f};
  float minY{-50.0f};
  float maxY{50.0f};
  std::vector<wildpaw::room::StaticCollider> colliders;
};

std::optional<LoadedMapRuntimeConfig> loadMapRuntimeConfig(
    const std::filesystem::path& mapDataRoot,
    std::string_view mapId,
    std::string* errorMessage = nullptr) {
  try {
    const auto mapFileName = toLowerAscii(std::string{mapId}) + ".json";
    const auto mapPath = mapDataRoot / mapFileName;

    boost::property_tree::ptree root;
    boost::property_tree::read_json(mapPath.string(), root);

    LoadedMapRuntimeConfig config;

    const float width = root.get<float>("size.width", 100.0f);
    const float height = root.get<float>("size.height", 100.0f);
    const float originX = root.get<float>("origin.x", 0.0f);
    const float originY = root.get<float>("origin.y", 0.0f);

    config.minX = originX - width * 0.5f;
    config.maxX = originX + width * 0.5f;
    config.minY = originY - height * 0.5f;
    config.maxY = originY + height * 0.5f;

    if (const auto prefabsNode = root.get_child_optional("prefabs")) {
      const auto& specs = prefabSpecs();

      for (const auto& [_, prefabNode] : *prefabsNode) {
        const auto code = prefabNode.get<std::string>("prefabCode", "");
        if (code.empty()) {
          continue;
        }

        const auto found = specs.find(code);
        if (found == specs.end()) {
          continue;
        }

        const auto& spec = found->second;
        const float x = prefabNode.get<float>("x", 0.0f);
        const float y = prefabNode.get<float>("y", 0.0f);
        const float rotDeg = prefabNode.get<float>("rotDeg", 0.0f);

        config.colliders.push_back(createRuntimeCollider(
            x, y, spec.sizeX, spec.sizeY, rotDeg, spec.blocksMovement,
            spec.blocksProjectile, spec.blocksLineOfSight));
      }
    }

    return config;
  } catch (const std::exception& ex) {
    if (errorMessage != nullptr) {
      *errorMessage = ex.what();
    }
    return std::nullopt;
  }
}

}  // namespace

class RoomServer;

class WsSession : public std::enable_shared_from_this<WsSession> {
 public:
  WsSession(tcp::socket&& socket,
            RoomServer& server,
            std::uint32_t playerId,
            std::string remoteIp,
            std::uint16_t remotePort)
      : ws_(std::move(socket)),
        server_(server),
        playerId_(playerId),
        remoteIp_(std::move(remoteIp)),
        remotePort_(remotePort),
        connectedAtMs_(unixTimeMs()),
        lastSeenAtMs_(connectedAtMs_),
        reliability_(playerId) {}

  void start();

  enum class ReliableClass {
    None = 0,
    Standard,
    Critical,
  };

  void sendBinary(std::vector<std::uint8_t> payload);
  void sendReliableBinary(std::uint32_t sequence,
                          std::vector<std::uint8_t> payload,
                          ReliableClass reliableClass = ReliableClass::Standard);

  void noteClientEnvelope(const wildpaw::room::wire::EnvelopeMeta& meta);
  void pumpRetransmit();

  [[nodiscard]] wildpaw::room::wire::EnvelopeMeta nextEnvelopeMeta() {
    std::lock_guard<std::mutex> lock(reliabilityMutex_);

    const std::uint32_t seq = reliability_.nextServerSequence();
    const auto& ackState = reliability_.outboundAckState();

    wildpaw::room::wire::EnvelopeMeta envelopeMeta;
    envelopeMeta.seq = seq;
    envelopeMeta.ack = ackState.ack;
    envelopeMeta.ackBits = ackState.ackBits;
    return envelopeMeta;
  }

  [[nodiscard]] std::size_t reliableInFlightCount() const {
    std::lock_guard<std::mutex> lock(reliableQueueMutex_);
    return reliableQueue_.size();
  }

  [[nodiscard]] std::uint32_t playerId() const { return playerId_; }

  [[nodiscard]] const std::string& remoteIp() const { return remoteIp_; }
  [[nodiscard]] std::uint16_t remotePort() const { return remotePort_; }

  [[nodiscard]] std::string remoteEndpoint() const {
    std::string out = remoteIp_;
    out.push_back(':');
    out += std::to_string(remotePort_);
    return out;
  }

  [[nodiscard]] std::uint64_t connectedAtMs() const { return connectedAtMs_; }
  [[nodiscard]] std::uint64_t lastSeenAtMs() const {
    return lastSeenAtMs_.load(std::memory_order_relaxed);
  }

  [[nodiscard]] std::uint64_t bytesIn() const {
    return bytesIn_.load(std::memory_order_relaxed);
  }
  [[nodiscard]] std::uint64_t bytesOut() const {
    return bytesOut_.load(std::memory_order_relaxed);
  }
  [[nodiscard]] std::uint64_t binaryFramesIn() const {
    return binaryFramesIn_.load(std::memory_order_relaxed);
  }
  [[nodiscard]] std::uint64_t textFramesIn() const {
    return textFramesIn_.load(std::memory_order_relaxed);
  }
  [[nodiscard]] std::uint64_t invalidEnvelopeTotal() const {
    return invalidEnvelopeTotal_.load(std::memory_order_relaxed);
  }
  [[nodiscard]] std::uint64_t unsupportedMessageTotal() const {
    return unsupportedMessageTotal_.load(std::memory_order_relaxed);
  }
  [[nodiscard]] std::uint64_t invalidProfileSelectTotal() const {
    return invalidProfileSelectTotal_.load(std::memory_order_relaxed);
  }

  void noteBinaryFrame(std::size_t bytes) {
    binaryFramesIn_.fetch_add(1, std::memory_order_relaxed);
    bytesIn_.fetch_add(bytes, std::memory_order_relaxed);
    lastSeenAtMs_.store(unixTimeMs(), std::memory_order_relaxed);
  }

  void noteTextFrame(std::size_t bytes) {
    textFramesIn_.fetch_add(1, std::memory_order_relaxed);
    bytesIn_.fetch_add(bytes, std::memory_order_relaxed);
    lastSeenAtMs_.store(unixTimeMs(), std::memory_order_relaxed);
  }

  void noteInvalidEnvelope() {
    invalidEnvelopeTotal_.fetch_add(1, std::memory_order_relaxed);
  }

  void noteUnsupportedMessage() {
    unsupportedMessageTotal_.fetch_add(1, std::memory_order_relaxed);
  }

  void noteInvalidProfileSelect() {
    invalidProfileSelectTotal_.fetch_add(1, std::memory_order_relaxed);
  }

  [[nodiscard]] bool isReady() const { return ready_; }
  void markReady() { ready_ = true; }

  void requestClose(std::string_view reason);

 private:
  struct ReliablePolicy {
    std::chrono::milliseconds timeout{120};
    std::uint8_t maxRetries{3};
  };

  struct ReliablePacket {
    std::uint32_t sequence{0};
    std::vector<std::uint8_t> payload;
    std::chrono::steady_clock::time_point lastSent{};
    std::uint8_t retries{0};
    std::uint8_t maxRetries{3};
    std::chrono::milliseconds timeout{120};
    ReliableClass reliableClass{ReliableClass::Standard};
  };

  static constexpr std::size_t kMaxReliableQueue = 256;

  static ReliablePolicy policyFor(ReliableClass reliableClass) {
    switch (reliableClass) {
      case ReliableClass::Critical:
        return ReliablePolicy{.timeout = std::chrono::milliseconds(180),
                              .maxRetries = 8};
      case ReliableClass::Standard:
        return ReliablePolicy{.timeout = std::chrono::milliseconds(120),
                              .maxRetries = 3};
      case ReliableClass::None:
      default:
        return ReliablePolicy{.timeout = std::chrono::milliseconds(0),
                              .maxRetries = 0};
    }
  }

  void doRead();
  void doWrite();
  void doCloseNow();
  void onClosed(const beast::error_code& ec);

  websocket::stream<beast::tcp_stream> ws_;
  beast::flat_buffer readBuffer_;
  std::deque<std::vector<std::uint8_t>> writeQueue_;

  RoomServer& server_;
  std::uint32_t playerId_{0};

  std::string remoteIp_;
  std::uint16_t remotePort_{0};

  std::uint64_t connectedAtMs_{0};
  std::atomic<std::uint64_t> lastSeenAtMs_{0};

  std::atomic<std::uint64_t> bytesIn_{0};
  std::atomic<std::uint64_t> bytesOut_{0};
  std::atomic<std::uint64_t> binaryFramesIn_{0};
  std::atomic<std::uint64_t> binaryFramesOut_{0};
  std::atomic<std::uint64_t> textFramesIn_{0};
  std::atomic<std::uint64_t> invalidEnvelopeTotal_{0};
  std::atomic<std::uint64_t> unsupportedMessageTotal_{0};
  std::atomic<std::uint64_t> invalidProfileSelectTotal_{0};

  mutable std::mutex reliabilityMutex_;
  wildpaw::room::RoomSession reliability_;

  mutable std::mutex reliableQueueMutex_;
  std::deque<ReliablePacket> reliableQueue_;

  bool closed_{false};
  bool closeRequested_{false};
  bool closing_{false};
  bool ready_{false};
  std::string closeReason_;
};

class RoomServer {
 public:
  RoomServer(net::io_context& io,
             const tcp::endpoint& endpoint,
             std::uint16_t tickRate,
             std::uint16_t teamSize,
             std::string rulesPath,
             std::filesystem::path mapDataRootPath,
             std::string roomTokenSecret)
      : io_(io),
        acceptor_(net::make_strand(io)),
        wsPort_(endpoint.port()),
        simulation_(tickRate),
        tickIntervalMs_(std::max<int>(1, 1000 / static_cast<int>(tickRate))),
        teamSize_(normalizeTeamSize(teamSize)),
        maxPlayersPerRoom_(static_cast<std::size_t>(teamSize_) * 2u),
        rulesPath_(std::move(rulesPath)),
        mapDataRootPath_(std::move(mapDataRootPath)),
        roomTokenSecret_(std::move(roomTokenSecret)) {
    beast::error_code ec;

    acceptor_.open(endpoint.protocol(), ec);
    if (ec) {
      throw beast::system_error(ec);
    }

    acceptor_.set_option(net::socket_base::reuse_address(true), ec);
    if (ec) {
      throw beast::system_error(ec);
    }

    acceptor_.bind(endpoint, ec);
    if (ec) {
      throw beast::system_error(ec);
    }

    acceptor_.listen(net::socket_base::max_listen_connections, ec);
    if (ec) {
      throw beast::system_error(ec);
    }

    std::error_code fsError;
    if (std::filesystem::exists(rulesPath_, fsError)) {
      rulesLastWriteTime_ = std::filesystem::last_write_time(rulesPath_, fsError);
    }

    if (roomTokenSecret_.empty()) {
      roomTokenSecret_ = "dev-room-secret";
    }

    applyMapRuntimeConfig("NJD_CR_01");
  }

  ~RoomServer() { stop(); }

  void start() {
    if (running_.exchange(true)) {
      return;
    }

    doAccept();
    startTickThread();
  }

  void stop() {
    if (!running_.exchange(false)) {
      return;
    }

    net::dispatch(acceptor_.get_executor(), [this]() {
      beast::error_code ec;
      acceptor_.cancel(ec);
      acceptor_.close(ec);
    });

    if (tickThread_.joinable()) {
      tickThread_.request_stop();
      tickThread_.join();
    }
  }

  void addRetransmitSent(std::size_t count) {
    retransmitSentTotal_.fetch_add(count, std::memory_order_relaxed);
  }

  void addRetransmitDropped(std::size_t count) {
    retransmitDroppedTotal_.fetch_add(count, std::memory_order_relaxed);
  }

  std::string renderPrometheusMetrics() {
    std::ostringstream out;

    const auto activeSessions = activeSessionCount();
    const auto pendingDepth = pendingInputDepth();
    const auto reliableInFlight = reliableInFlightTotal();

    out << "# HELP wildpaw_room_active_sessions Active websocket sessions\n";
    out << "# TYPE wildpaw_room_active_sessions gauge\n";
    out << "wildpaw_room_active_sessions " << activeSessions << "\n";

    out << "# HELP wildpaw_room_pending_input_queue_depth Pending input queue depth\n";
    out << "# TYPE wildpaw_room_pending_input_queue_depth gauge\n";
    out << "wildpaw_room_pending_input_queue_depth " << pendingDepth << "\n";

    out << "# HELP wildpaw_room_pending_input_queue_peak Peak pending input queue depth\n";
    out << "# TYPE wildpaw_room_pending_input_queue_peak gauge\n";
    out << "wildpaw_room_pending_input_queue_peak "
        << pendingInputQueuePeak_.load(std::memory_order_relaxed) << "\n";

    out << "# HELP wildpaw_room_dropped_input_frames_total Dropped input frames\n";
    out << "# TYPE wildpaw_room_dropped_input_frames_total counter\n";
    out << "wildpaw_room_dropped_input_frames_total "
        << droppedInputFrames_.load(std::memory_order_relaxed) << "\n";

    out << "# HELP wildpaw_room_input_frames_total Input frames accepted\n";
    out << "# TYPE wildpaw_room_input_frames_total counter\n";
    out << "wildpaw_room_input_frames_total "
        << inputFramesTotal_.load(std::memory_order_relaxed) << "\n";

    out << "# HELP wildpaw_room_tick_total Tick count\n";
    out << "# TYPE wildpaw_room_tick_total counter\n";
    out << "wildpaw_room_tick_total "
        << tickTotal_.load(std::memory_order_relaxed) << "\n";

    out << "# HELP wildpaw_room_tick_overrun_total Tick overrun count\n";
    out << "# TYPE wildpaw_room_tick_overrun_total counter\n";
    out << "wildpaw_room_tick_overrun_total "
        << tickOverrunTotal_.load(std::memory_order_relaxed) << "\n";

    out << "# HELP wildpaw_room_tick_last_duration_ms Last tick duration in ms\n";
    out << "# TYPE wildpaw_room_tick_last_duration_ms gauge\n";
    out << "wildpaw_room_tick_last_duration_ms "
        << (lastTickDurationMicros_.load(std::memory_order_relaxed) / 1000.0)
        << "\n";

    out << "# HELP wildpaw_room_snapshot_base_sent_total Base snapshots sent\n";
    out << "# TYPE wildpaw_room_snapshot_base_sent_total counter\n";
    out << "wildpaw_room_snapshot_base_sent_total "
        << snapshotBaseSentTotal_.load(std::memory_order_relaxed) << "\n";

    out << "# HELP wildpaw_room_snapshot_delta_sent_total Delta snapshots sent\n";
    out << "# TYPE wildpaw_room_snapshot_delta_sent_total counter\n";
    out << "wildpaw_room_snapshot_delta_sent_total "
        << snapshotDeltaSentTotal_.load(std::memory_order_relaxed) << "\n";

    out << "# HELP wildpaw_room_event_sent_total Event payloads sent\n";
    out << "# TYPE wildpaw_room_event_sent_total counter\n";
    out << "wildpaw_room_event_sent_total "
        << eventSentTotal_.load(std::memory_order_relaxed) << "\n";

    out << "# HELP wildpaw_room_combat_event_sent_total Combat event payloads sent\n";
    out << "# TYPE wildpaw_room_combat_event_sent_total counter\n";
    out << "wildpaw_room_combat_event_sent_total "
        << combatEventSentTotal_.load(std::memory_order_relaxed) << "\n";

    out << "# HELP wildpaw_room_projectile_event_sent_total Projectile event payloads sent\n";
    out << "# TYPE wildpaw_room_projectile_event_sent_total counter\n";
    out << "wildpaw_room_projectile_event_sent_total "
        << projectileEventSentTotal_.load(std::memory_order_relaxed) << "\n";

    out << "# HELP wildpaw_room_combat_event_filtered_total Combat events filtered by interest\n";
    out << "# TYPE wildpaw_room_combat_event_filtered_total counter\n";
    out << "wildpaw_room_combat_event_filtered_total "
        << combatEventFilteredTotal_.load(std::memory_order_relaxed) << "\n";

    out << "# HELP wildpaw_room_projectile_event_filtered_total Projectile events filtered by interest\n";
    out << "# TYPE wildpaw_room_projectile_event_filtered_total counter\n";
    out << "wildpaw_room_projectile_event_filtered_total "
        << projectileEventFilteredTotal_.load(std::memory_order_relaxed) << "\n";

    out << "# HELP wildpaw_room_rule_reload_success_total Rule hot-reload success count\n";
    out << "# TYPE wildpaw_room_rule_reload_success_total counter\n";
    out << "wildpaw_room_rule_reload_success_total "
        << ruleReloadSuccessTotal_.load(std::memory_order_relaxed) << "\n";

    out << "# HELP wildpaw_room_rule_reload_failure_total Rule hot-reload failure count\n";
    out << "# TYPE wildpaw_room_rule_reload_failure_total counter\n";
    out << "wildpaw_room_rule_reload_failure_total "
        << ruleReloadFailureTotal_.load(std::memory_order_relaxed) << "\n";

    out << "# HELP wildpaw_room_reliable_inflight_packets Reliable in-flight packets\n";
    out << "# TYPE wildpaw_room_reliable_inflight_packets gauge\n";
    out << "wildpaw_room_reliable_inflight_packets " << reliableInFlight << "\n";

    out << "# HELP wildpaw_room_retransmit_sent_total Retransmitted packets\n";
    out << "# TYPE wildpaw_room_retransmit_sent_total counter\n";
    out << "wildpaw_room_retransmit_sent_total "
        << retransmitSentTotal_.load(std::memory_order_relaxed) << "\n";

    out << "# HELP wildpaw_room_retransmit_dropped_total Retransmit-dropped packets\n";
    out << "# TYPE wildpaw_room_retransmit_dropped_total counter\n";
    out << "wildpaw_room_retransmit_dropped_total "
        << retransmitDroppedTotal_.load(std::memory_order_relaxed) << "\n";

    return out.str();
  }

  struct ViolationEvent {
    std::uint64_t timeMs{0};
    std::uint32_t playerId{0};
    std::string remoteEndpoint;
    std::string type;
    std::string detail;
  };

  void recordViolation(std::uint32_t playerId,
                       std::string_view remoteEndpoint,
                       std::string_view type,
                       std::string_view detail) {
    ViolationEvent event;
    event.timeMs = unixTimeMs();
    event.playerId = playerId;
    event.remoteEndpoint = std::string{remoteEndpoint};
    event.type = std::string{type};
    event.detail = std::string{detail};

    {
      std::lock_guard<std::mutex> lock(violationsMutex_);
      violations_.push_back(std::move(event));
      while (violations_.size() > kMaxViolations) {
        violations_.pop_front();
      }
    }
  }

  std::string renderAdminStatusJson() {
    std::ostringstream out;

    const auto profiles = []() {
      auto ids = wildpaw::room::combatRuleProfileIds();
      std::sort(ids.begin(), ids.end());
      return ids;
    }();

    const auto [teamOneCount, teamTwoCount] = currentTeamOccupancy();

    out << '{';
    out << "\"nowMs\":" << unixTimeMs() << ',';
    out << "\"rooms\":1,";
    out << "\"teamSize\":" << teamSize_ << ',';
    out << "\"maxPlayersPerRoom\":" << maxPlayersPerRoom_ << ',';
    std::string activeMatchId;
    std::string activeMapId;
    std::uint64_t activeRoomExpiresAtMs = 0;
    bool soloPracticeMode = false;
    bool soloPracticeDummySpawned = false;
    {
      std::lock_guard<std::mutex> lock(roomRuntimeMutex_);
      activeMatchId = activeMatchId_;
      activeMapId = activeMapId_;
      activeRoomExpiresAtMs = activeRoomExpiresAtMs_;
      soloPracticeMode = soloPracticeMode_;
      soloPracticeDummySpawned = soloPracticeDummySpawned_;
    }

    out << "\"teamOccupancy\":{";
    out << "\"team1\":" << teamOneCount << ',';
    out << "\"team2\":" << teamTwoCount;
    out << "},";
    out << "\"activeMatchId\":\"" << jsonEscape(activeMatchId) << "\",";
    out << "\"activeMapId\":\"" << jsonEscape(activeMapId) << "\",";
    out << "\"activeRoomExpiresAtMs\":" << activeRoomExpiresAtMs << ',';
    out << "\"soloPracticeMode\":" << (soloPracticeMode ? "true" : "false") << ',';
    out << "\"soloPracticeDummySpawned\":"
        << (soloPracticeDummySpawned ? "true" : "false") << ',';
    out << "\"wsPort\":" << wsPort_ << ',';
    out << "\"tickRate\":" << simulation_.tickRate() << ',';
    out << "\"currentTick\":" << tickTotal_.load(std::memory_order_relaxed)
        << ',';
    out << "\"rulesPath\":\"" << jsonEscape(rulesPath_) << "\",";
    out << "\"defaultProfile\":\""
        << jsonEscape(wildpaw::room::defaultCombatRuleProfileId()) << "\",";

    out << "\"profiles\":[";
    for (std::size_t i = 0; i < profiles.size(); ++i) {
      if (i > 0) {
        out << ',';
      }
      out << "\"" << jsonEscape(profiles[i]) << "\"";
    }
    out << "],";

    out << "\"metrics\":{";
    out << "\"activeSessions\":" << activeSessionCount() << ',';
    out << "\"pendingInputDepth\":" << pendingInputDepth() << ',';
    out << "\"pendingInputPeak\":"
        << pendingInputQueuePeak_.load(std::memory_order_relaxed) << ',';
    out << "\"droppedInputFramesTotal\":"
        << droppedInputFrames_.load(std::memory_order_relaxed) << ',';
    out << "\"inputFramesTotal\":"
        << inputFramesTotal_.load(std::memory_order_relaxed) << ',';
    out << "\"tickTotal\":" << tickTotal_.load(std::memory_order_relaxed)
        << ',';
    out << "\"tickOverrunTotal\":"
        << tickOverrunTotal_.load(std::memory_order_relaxed) << ',';
    out << "\"tickLastDurationMs\":"
        << (lastTickDurationMicros_.load(std::memory_order_relaxed) / 1000.0)
        << ',';
    out << "\"snapshotBaseSentTotal\":"
        << snapshotBaseSentTotal_.load(std::memory_order_relaxed) << ',';
    out << "\"snapshotDeltaSentTotal\":"
        << snapshotDeltaSentTotal_.load(std::memory_order_relaxed) << ',';
    out << "\"eventSentTotal\":"
        << eventSentTotal_.load(std::memory_order_relaxed) << ',';
    out << "\"combatEventSentTotal\":"
        << combatEventSentTotal_.load(std::memory_order_relaxed) << ',';
    out << "\"projectileEventSentTotal\":"
        << projectileEventSentTotal_.load(std::memory_order_relaxed) << ',';
    out << "\"combatEventFilteredTotal\":"
        << combatEventFilteredTotal_.load(std::memory_order_relaxed) << ',';
    out << "\"projectileEventFilteredTotal\":"
        << projectileEventFilteredTotal_.load(std::memory_order_relaxed) << ',';
    out << "\"ruleReloadSuccessTotal\":"
        << ruleReloadSuccessTotal_.load(std::memory_order_relaxed) << ',';
    out << "\"ruleReloadFailureTotal\":"
        << ruleReloadFailureTotal_.load(std::memory_order_relaxed) << ',';
    out << "\"reliableInFlight\":" << reliableInFlightTotal() << ',';
    out << "\"retransmitSentTotal\":"
        << retransmitSentTotal_.load(std::memory_order_relaxed) << ',';
    out << "\"retransmitDroppedTotal\":"
        << retransmitDroppedTotal_.load(std::memory_order_relaxed);
    out << '}';

    out << '}';
    return out.str();
  }

  std::string renderAdminSessionsJson() {
    std::ostringstream out;

    out << '{';
    out << "\"nowMs\":" << unixTimeMs() << ',';
    out << "\"sessions\":[";

    struct SessionView {
      std::shared_ptr<WsSession> session;
      TeamAssignment assignment;
    };

    std::vector<SessionView> sessions;
    {
      std::lock_guard<std::mutex> lock(sessionsMutex_);
      sessions.reserve(sessions_.size());
      for (const auto& [playerId, session] : sessions_) {
        TeamAssignment assignment;
        if (const auto found = teamAssignments_.find(playerId);
            found != teamAssignments_.end()) {
          assignment = found->second;
        }
        sessions.push_back(SessionView{.session = session, .assignment = assignment});
      }
    }

    std::sort(sessions.begin(), sessions.end(),
              [](const SessionView& a, const SessionView& b) {
                return a.session->playerId() < b.session->playerId();
              });

    for (std::size_t i = 0; i < sessions.size(); ++i) {
      const auto& view = sessions[i];
      const auto& session = view.session;
      if (i > 0) {
        out << ',';
      }

      out << '{';
      out << "\"playerId\":" << session->playerId() << ',';
      out << "\"teamId\":" << static_cast<int>(view.assignment.teamId) << ',';
      out << "\"teamSlot\":" << view.assignment.slot << ',';
      out << "\"remote\":\"" << jsonEscape(session->remoteEndpoint())
          << "\",";
      out << "\"connectedAtMs\":" << session->connectedAtMs() << ',';
      out << "\"lastSeenAtMs\":" << session->lastSeenAtMs() << ',';
      out << "\"bytesIn\":" << session->bytesIn() << ',';
      out << "\"bytesOut\":" << session->bytesOut() << ',';
      out << "\"binaryFramesIn\":" << session->binaryFramesIn() << ',';
      out << "\"textFramesIn\":" << session->textFramesIn() << ',';
      out << "\"invalidEnvelopeTotal\":" << session->invalidEnvelopeTotal()
          << ',';
      out << "\"unsupportedMessageTotal\":"
          << session->unsupportedMessageTotal() << ',';
      out << "\"invalidProfileSelectTotal\":"
          << session->invalidProfileSelectTotal() << ',';
      out << "\"reliableInFlight\":" << session->reliableInFlightCount();
      out << '}';
    }

    out << "]";
    out << '}';
    return out.str();
  }

  std::string renderAdminViolationsJson() {
    std::ostringstream out;

    out << '{';
    out << "\"nowMs\":" << unixTimeMs() << ',';
    out << "\"violations\":[";

    std::deque<ViolationEvent> copy;
    {
      std::lock_guard<std::mutex> lock(violationsMutex_);
      copy = violations_;
    }

    for (std::size_t i = 0; i < copy.size(); ++i) {
      const auto& ev = copy[i];
      if (i > 0) {
        out << ',';
      }

      out << '{';
      out << "\"timeMs\":" << ev.timeMs << ',';
      out << "\"playerId\":" << ev.playerId << ',';
      out << "\"remote\":\"" << jsonEscape(ev.remoteEndpoint) << "\",";
      out << "\"type\":\"" << jsonEscape(ev.type) << "\",";
      out << "\"detail\":\"" << jsonEscape(ev.detail) << "\"";
      out << '}';
    }

    out << "]";
    out << '}';
    return out.str();
  }

  bool disconnectSession(std::uint32_t playerId) {
    auto session = getSession(playerId);
    if (!session) {
      return false;
    }

    recordViolation(playerId, session->remoteEndpoint(), "admin_disconnect",
                    "disconnect requested");
    session->requestClose("admin_disconnect");
    return true;
  }

  bool reloadRulesNow(std::string* errorMessage = nullptr) {
    std::string error;
    if (!wildpaw::room::loadCombatRuleProfilesFromJson(rulesPath_, &error)) {
      ruleReloadFailureTotal_.fetch_add(1, std::memory_order_relaxed);
      if (errorMessage != nullptr) {
        *errorMessage = error;
      }
      recordViolation(0, "-", "rules_reload_failed", error);
      return false;
    }

    std::error_code fsError;
    if (std::filesystem::exists(rulesPath_, fsError)) {
      rulesLastWriteTime_ = std::filesystem::last_write_time(rulesPath_, fsError);
    }

    ruleReloadSuccessTotal_.fetch_add(1, std::memory_order_relaxed);
    if (errorMessage != nullptr) {
      errorMessage->clear();
    }

    return true;
  }

  void ensureSoloPracticeDummyLocked() {
    if (!soloPracticeMode_ || soloPracticeDummySpawned_) {
      return;
    }

    simulation_.addPlayer(kSoloPracticeDummyPlayerId, 2, 1);
    simulation_.setPlayerProfile(kSoloPracticeDummyPlayerId,
                                 wildpaw::room::defaultCombatRuleProfileId());
    soloPracticeDummySpawned_ = true;

    std::cout << "[room] solo practice dummy spawned playerId="
              << kSoloPracticeDummyPlayerId << '\n';
  }

  void removeSoloPracticeDummyLocked() {
    if (!soloPracticeDummySpawned_) {
      return;
    }

    simulation_.removePlayer(kSoloPracticeDummyPlayerId);
    soloPracticeDummySpawned_ = false;

    std::cout << "[room] solo practice dummy removed playerId="
              << kSoloPracticeDummyPlayerId << '\n';
  }

  void applyMapRuntimeConfig(std::string_view mapId) {
    const auto loaded = loadMapRuntimeConfig(mapDataRootPath_, mapId);
    if (!loaded.has_value()) {
      simulation_.setMapBounds(-50.0f, 50.0f, -50.0f, 50.0f);
      simulation_.setStaticColliders({});
      std::cerr << "[room] map runtime load failed mapId=" << mapId
                << " path=" << mapDataRootPath_.string()
                << " fallback=world-boundary-only\n";
      return;
    }

    simulation_.setMapBounds(loaded->minX, loaded->maxX,
                             loaded->minY, loaded->maxY);
    simulation_.setStaticColliders(loaded->colliders);

    std::cout << "[room] map runtime configured mapId=" << mapId
              << " boundsX=[" << loaded->minX << "," << loaded->maxX << "]"
              << " boundsY=[" << loaded->minY << "," << loaded->maxY << "]"
              << " colliders=" << loaded->colliders.size() << '\n';
  }

  bool onSessionReady(const std::shared_ptr<WsSession>& session,
                      std::string_view roomToken,
                      std::string_view clientVersion) {
    const std::uint32_t playerId = session->playerId();

    if (session->isReady()) {
      sendEventWithPolicy(session, "hello.ack", "already-ready",
                          WsSession::ReliableClass::Standard);
      return true;
    }

    const auto parsedToken =
        parseRoomToken(roomToken, roomTokenSecret_, unixTimeMs());
    if (!parsedToken.ok) {
      recordViolation(playerId, session->remoteEndpoint(), "room_token_invalid",
                      parsedToken.error);

      const auto invalidMeta = session->nextEnvelopeMeta();
      auto invalidPayload = wildpaw::room::wire::encodeEventEnvelope(
          "room.token.invalid", parsedToken.error, invalidMeta);
      session->sendReliableBinary(invalidMeta.seq, std::move(invalidPayload),
                                  WsSession::ReliableClass::Standard);
      session->requestClose("room.token.invalid");
      return false;
    }

    bool soloPracticeMode = false;
    {
      std::lock_guard<std::mutex> lock(roomRuntimeMutex_);
      if (activeMatchId_.empty()) {
        activeMatchId_ = parsedToken.matchId;
        activeMapId_ = parsedToken.mapId;
        activeRoomExpiresAtMs_ = parsedToken.expiresAtMs;
        soloPracticeMode_ = isSoloPracticeMatchId(activeMatchId_);
        soloPracticeDummySpawned_ = false;
        applyMapRuntimeConfig(activeMapId_);
      } else {
        if (parsedToken.matchId != activeMatchId_) {
          std::ostringstream detail;
          detail << "activeMatch=" << activeMatchId_
                 << " incomingMatch=" << parsedToken.matchId;
          const auto detailText = detail.str();
          recordViolation(playerId, session->remoteEndpoint(), "room_token_mismatch",
                          detailText);

          const auto mismatchMeta = session->nextEnvelopeMeta();
          auto mismatchPayload = wildpaw::room::wire::encodeEventEnvelope(
              "room.match.mismatch", detailText, mismatchMeta);
          session->sendReliableBinary(mismatchMeta.seq,
                                      std::move(mismatchPayload),
                                      WsSession::ReliableClass::Standard);
          session->requestClose("room.match.mismatch");
          return false;
        }

        if (!activeMapId_.empty() && parsedToken.mapId != activeMapId_) {
          std::ostringstream detail;
          detail << "activeMap=" << activeMapId_
                 << " incomingMap=" << parsedToken.mapId;
          const auto detailText = detail.str();
          recordViolation(playerId, session->remoteEndpoint(), "room_map_mismatch",
                          detailText);

          const auto mismatchMeta = session->nextEnvelopeMeta();
          auto mismatchPayload = wildpaw::room::wire::encodeEventEnvelope(
              "room.map.mismatch", detailText, mismatchMeta);
          session->sendReliableBinary(mismatchMeta.seq,
                                      std::move(mismatchPayload),
                                      WsSession::ReliableClass::Standard);
          session->requestClose("room.map.mismatch");
          return false;
        }

        activeRoomExpiresAtMs_ =
            std::max(activeRoomExpiresAtMs_, parsedToken.expiresAtMs);
      }

      soloPracticeMode = soloPracticeMode_;
    }

    TeamAssignment assignment;
    bool accepted = false;

    {
      std::lock_guard<std::mutex> lock(sessionsMutex_);
      sessions_[playerId] = session;

      if (const auto found = teamAssignments_.find(playerId);
          found != teamAssignments_.end()) {
        assignment = found->second;
        accepted = true;
      } else if (!(soloPracticeMode && !teamAssignments_.empty()) &&
                 teamAssignments_.size() < maxPlayersPerRoom_) {
        const auto reserved = allocateTeamAssignmentLocked();
        if (reserved.has_value()) {
          assignment = reserved.value();
          teamAssignments_[playerId] = assignment;
          accepted = true;
        }
      }
    }

    if (!accepted) {
      std::ostringstream detail;
      detail << "capacity reached active=" << activeSessionCount()
             << " maxPlayersPerRoom=" << maxPlayersPerRoom_
             << " teamSize=" << teamSize_;
      if (soloPracticeMode) {
        detail << " soloPractice=1";
      }
      const std::string detailText = detail.str();

      recordViolation(playerId, session->remoteEndpoint(), "room_full", detailText);

      const auto fullMeta = session->nextEnvelopeMeta();
      auto fullPayload = wildpaw::room::wire::encodeEventEnvelope(
          "room.full", detailText, fullMeta);
      session->sendReliableBinary(fullMeta.seq, std::move(fullPayload),
                                  WsSession::ReliableClass::Standard);
      session->requestClose("room.full");
      return false;
    }

    wildpaw::room::WorldSnapshot baseSnapshot;
    {
      std::lock_guard<std::mutex> lock(simulationMutex_);
      simulation_.addPlayer(playerId, assignment.teamId, assignment.slot);
      if (soloPracticeMode) {
        ensureSoloPracticeDummyLocked();
      }
      baseSnapshot = simulation_.snapshot();
    }

    session->markReady();

    std::ostringstream helloAckMessage;
    helloAckMessage << "{\"status\":\"ok\",\"matchId\":\""
                    << jsonEscape(parsedToken.matchId)
                    << "\",\"mapId\":\"" << jsonEscape(parsedToken.mapId)
                    << "\",\"clientVersion\":\""
                    << jsonEscape(std::string{clientVersion}) << "\"}";
    sendEventWithPolicy(session, "hello.ack", helloAckMessage.str(),
                        WsSession::ReliableClass::Standard);

    const auto welcomeMeta = session->nextEnvelopeMeta();
    auto welcomePayload = wildpaw::room::wire::encodeWelcomeEnvelope(
        playerId, simulation_.tickRate(), simulation_.currentTick(), welcomeMeta);
    session->sendReliableBinary(welcomeMeta.seq, std::move(welcomePayload),
                                WsSession::ReliableClass::Critical);

    const auto baseMeta = session->nextEnvelopeMeta();
    auto basePayload = wildpaw::room::wire::encodeSnapshotEnvelope(
        false, baseSnapshot.serverTick, unixTimeMs(), baseSnapshot.players,
        std::span<const std::uint32_t>{}, baseMeta);
    session->sendReliableBinary(baseMeta.seq, std::move(basePayload),
                                WsSession::ReliableClass::Critical);
    snapshotBaseSentTotal_.fetch_add(1, std::memory_order_relaxed);

    std::ostringstream teamAssignedMessage;
    teamAssignedMessage << "{\"teamId\":" << static_cast<int>(assignment.teamId)
                        << ",\"teamSlot\":" << assignment.slot
                        << ",\"teamSize\":" << teamSize_ << "}";
    sendEventWithPolicy(session, "team.assigned", teamAssignedMessage.str(),
                        WsSession::ReliableClass::Standard);

    std::cout << "[room] player connected: " << playerId
              << " team=" << static_cast<int>(assignment.teamId)
              << " slot=" << assignment.slot
              << " activePlayers=" << activeSessionCount() << "/"
              << maxPlayersPerRoom_ << " match=" << parsedToken.matchId
              << " map=" << parsedToken.mapId << '\n';

    return true;
  }

  void onSessionBinaryMessage(std::uint32_t playerId,
                              std::span<const std::uint8_t> payload) {
    auto session = getSession(playerId);
    if (!session) {
      return;
    }

    const auto decoded = wildpaw::room::wire::decodeClientEnvelope(payload);
    if (!decoded.has_value()) {
      session->noteInvalidEnvelope();
      recordViolation(playerId, session->remoteEndpoint(), "invalid_envelope",
                      "decodeClientEnvelope failed");
      sendEventWithPolicy(session, "warn", "invalid-envelope",
                          WsSession::ReliableClass::None);
      return;
    }

    session->noteClientEnvelope(decoded->meta);

    if (!session->isReady() &&
        decoded->type != wildpaw::room::wire::ClientMessageType::Hello) {
      recordViolation(playerId, session->remoteEndpoint(), "pre_hello_message",
                      "non-hello message before authentication");
      sendEventWithPolicy(session, "warn", "hello-required",
                          WsSession::ReliableClass::None);
      return;
    }

    switch (decoded->type) {
      case wildpaw::room::wire::ClientMessageType::Hello:
        onSessionReady(session, decoded->roomToken, decoded->clientVersion);
        return;

      case wildpaw::room::wire::ClientMessageType::Input:
      case wildpaw::room::wire::ClientMessageType::ActionCommand:
        enqueueInput(playerId, decoded->input);
        inputFramesTotal_.fetch_add(1, std::memory_order_relaxed);
        return;

      case wildpaw::room::wire::ClientMessageType::SelectProfile: {
        const bool applied = setPlayerProfile(playerId, decoded->profileId);
        if (applied) {
          sendEventWithPolicy(session, "profile.applied", decoded->profileId,
                              WsSession::ReliableClass::Standard);
        } else {
          session->noteInvalidProfileSelect();
          recordViolation(playerId, session->remoteEndpoint(), "profile_invalid",
                          decoded->profileId);
          sendEventWithPolicy(session, "profile.invalid", decoded->profileId,
                              WsSession::ReliableClass::Standard);
        }
        return;
      }

      case wildpaw::room::wire::ClientMessageType::Ping:
        sendEventWithPolicy(session, "pong", "ok",
                            WsSession::ReliableClass::None);
        return;

      default:
        session->noteUnsupportedMessage();
        recordViolation(playerId, session->remoteEndpoint(),
                        "unsupported_message_type",
                        "unsupported message type");
        sendEventWithPolicy(session, "warn", "unsupported-message-type",
                            WsSession::ReliableClass::None);
        return;
    }
  }

  void onSessionClosed(std::uint32_t playerId) {
    bool becameEmpty = false;
    {
      std::lock_guard<std::mutex> lock(sessionsMutex_);
      sessions_.erase(playerId);
      teamAssignments_.erase(playerId);
      becameEmpty = teamAssignments_.empty();
    }

    {
      std::lock_guard<std::mutex> lock(simulationMutex_);
      simulation_.removePlayer(playerId);
      if (becameEmpty) {
        removeSoloPracticeDummyLocked();
      }
    }

    if (becameEmpty) {
      std::lock_guard<std::mutex> lock(roomRuntimeMutex_);
      activeMatchId_.clear();
      activeMapId_.clear();
      activeRoomExpiresAtMs_ = 0;
      soloPracticeMode_ = false;
      soloPracticeDummySpawned_ = false;
    }

    std::cout << "[room] player disconnected: " << playerId
              << " activePlayers=" << activeSessionCount() << "/"
              << maxPlayersPerRoom_ << '\n';
  }

 private:
  struct PendingInput {
    std::uint32_t playerId{0};
    wildpaw::room::InputFrame input{};
  };

  struct TeamAssignment {
    std::uint8_t teamId{0};
    std::uint16_t slot{0};
  };

  static constexpr std::size_t kMaxPendingInputFrames = 100000;
  static constexpr std::size_t kMaxViolations = 200;

  std::shared_ptr<WsSession> getSession(std::uint32_t playerId) {
    std::lock_guard<std::mutex> lock(sessionsMutex_);
    const auto found = sessions_.find(playerId);
    if (found == sessions_.end()) {
      return nullptr;
    }
    return found->second;
  }

  [[nodiscard]] std::size_t activeSessionCount() {
    std::lock_guard<std::mutex> lock(sessionsMutex_);
    return teamAssignments_.size();
  }

  [[nodiscard]] std::pair<std::size_t, std::size_t> currentTeamOccupancy() {
    std::size_t teamOne = 0;
    std::size_t teamTwo = 0;

    std::lock_guard<std::mutex> lock(sessionsMutex_);
    for (const auto& [_, assignment] : teamAssignments_) {
      if (assignment.teamId == 1) {
        ++teamOne;
      } else if (assignment.teamId == 2) {
        ++teamTwo;
      }
    }

    return {teamOne, teamTwo};
  }

  [[nodiscard]] std::optional<TeamAssignment> allocateTeamAssignmentLocked() {
    if (teamSize_ == 0) {
      return std::nullopt;
    }

    if (teamAssignments_.size() >= maxPlayersPerRoom_) {
      return std::nullopt;
    }

    std::vector<bool> teamOneUsed(teamSize_, false);
    std::vector<bool> teamTwoUsed(teamSize_, false);
    std::size_t teamOneCount = 0;
    std::size_t teamTwoCount = 0;

    for (const auto& [_, assignment] : teamAssignments_) {
      if (assignment.teamId == 1) {
        ++teamOneCount;
        if (assignment.slot >= 1 && assignment.slot <= teamSize_) {
          teamOneUsed[assignment.slot - 1] = true;
        }
      } else if (assignment.teamId == 2) {
        ++teamTwoCount;
        if (assignment.slot >= 1 && assignment.slot <= teamSize_) {
          teamTwoUsed[assignment.slot - 1] = true;
        }
      }
    }

    auto findOpenSlot = [&](std::uint8_t teamId) -> std::optional<std::uint16_t> {
      const auto& used = (teamId == 1) ? teamOneUsed : teamTwoUsed;
      for (std::uint16_t i = 0; i < teamSize_; ++i) {
        if (!used[i]) {
          return static_cast<std::uint16_t>(i + 1);
        }
      }
      return std::nullopt;
    };

    std::uint8_t preferredTeam = 1;
    if (teamTwoCount < teamOneCount) {
      preferredTeam = 2;
    }

    auto slot = findOpenSlot(preferredTeam);
    if (!slot.has_value()) {
      preferredTeam = preferredTeam == 1 ? 2 : 1;
      slot = findOpenSlot(preferredTeam);
    }

    if (!slot.has_value()) {
      return std::nullopt;
    }

    TeamAssignment assignment;
    assignment.teamId = preferredTeam;
    assignment.slot = slot.value();
    return assignment;
  }

  [[nodiscard]] std::size_t pendingInputDepth() {
    std::lock_guard<std::mutex> lock(pendingInputMutex_);
    return pendingInputs_.size();
  }

  [[nodiscard]] std::size_t reliableInFlightTotal() {
    std::size_t total = 0;
    std::lock_guard<std::mutex> lock(sessionsMutex_);
    for (const auto& [_, session] : sessions_) {
      total += session->reliableInFlightCount();
    }
    return total;
  }

  void sendEventWithPolicy(const std::shared_ptr<WsSession>& session,
                           std::string_view name,
                           std::string_view message,
                           WsSession::ReliableClass reliableClass) {
    const auto meta = session->nextEnvelopeMeta();
    auto payload = wildpaw::room::wire::encodeEventEnvelope(name, message, meta);

    if (reliableClass == WsSession::ReliableClass::None) {
      session->sendBinary(std::move(payload));
    } else {
      session->sendReliableBinary(meta.seq, std::move(payload), reliableClass);
    }

    eventSentTotal_.fetch_add(1, std::memory_order_relaxed);
  }

  bool setPlayerProfile(std::uint32_t playerId, std::string_view profileId) {
    if (profileId.empty()) {
      return false;
    }

    std::lock_guard<std::mutex> lock(simulationMutex_);
    return simulation_.setPlayerProfile(playerId, profileId);
  }

  void enqueueInput(std::uint32_t playerId, const wildpaw::room::InputFrame& input) {
    std::size_t currentSize = 0;

    {
      std::lock_guard<std::mutex> lock(pendingInputMutex_);

      if (pendingInputs_.size() >= kMaxPendingInputFrames) {
        pendingInputs_.pop_front();
        droppedInputFrames_.fetch_add(1, std::memory_order_relaxed);
      }

      pendingInputs_.push_back(PendingInput{.playerId = playerId, .input = input});
      currentSize = pendingInputs_.size();
    }

    auto previousPeak = pendingInputQueuePeak_.load(std::memory_order_relaxed);
    while (currentSize > previousPeak &&
           !pendingInputQueuePeak_.compare_exchange_weak(
               previousPeak, currentSize, std::memory_order_relaxed,
               std::memory_order_relaxed)) {
    }
  }

  std::deque<PendingInput> drainPendingInputs() {
    std::deque<PendingInput> drained;

    std::lock_guard<std::mutex> lock(pendingInputMutex_);
    drained.swap(pendingInputs_);

    return drained;
  }

  std::vector<std::pair<std::uint32_t, std::shared_ptr<WsSession>>> snapshotSessions() {
    std::vector<std::pair<std::uint32_t, std::shared_ptr<WsSession>>> copy;

    std::lock_guard<std::mutex> lock(sessionsMutex_);
    copy.reserve(sessions_.size());
    for (const auto& [playerId, session] : sessions_) {
      if (!session || !session->isReady()) {
        continue;
      }
      copy.emplace_back(playerId, session);
    }

    return copy;
  }

  void doAccept() {
    if (!running_.load(std::memory_order_relaxed)) {
      return;
    }

    acceptor_.async_accept(net::make_strand(io_),
                           [this](beast::error_code ec, tcp::socket socket) {
                             if (ec) {
                               if (ec != net::error::operation_aborted) {
                                 std::cerr << "[room] accept failed: " << ec.message()
                                           << '\n';
                               }
                             } else {
                               beast::error_code epEc;
                               const auto endpoint = socket.remote_endpoint(epEc);
                               std::string remoteIp = "unknown";
                               std::uint16_t remotePort = 0;

                               if (!epEc) {
                                 remoteIp = endpoint.address().to_string();
                                 remotePort = endpoint.port();
                               }

                               const std::uint32_t playerId = nextPlayerId_++;
                               auto session = std::make_shared<WsSession>(
                                   std::move(socket), *this, playerId,
                                   std::move(remoteIp), remotePort);

                               {
                                 std::lock_guard<std::mutex> lock(sessionsMutex_);
                                 sessions_[playerId] = session;
                               }

                               session->start();
                             }

                             if (running_.load(std::memory_order_relaxed)) {
                               doAccept();
                             }
                           });
  }

  void startTickThread() {
    tickThread_ = std::jthread([this](std::stop_token stopToken) {
      using clock = std::chrono::steady_clock;
      auto next = clock::now();

      while (running_.load(std::memory_order_relaxed) &&
             !stopToken.stop_requested()) {
        next += std::chrono::milliseconds(tickIntervalMs_);
        tickOnce();
        std::this_thread::sleep_until(next);
      }
    });
  }

  void maybeReloadRules() {
    using clock = std::chrono::steady_clock;
    const auto now = clock::now();

    if (now < nextRuleReloadCheckAt_) {
      return;
    }

    nextRuleReloadCheckAt_ = now + std::chrono::seconds(1);

    std::error_code fsError;
    if (!std::filesystem::exists(rulesPath_, fsError)) {
      return;
    }

    const auto writeTime = std::filesystem::last_write_time(rulesPath_, fsError);
    if (fsError) {
      return;
    }

    if (rulesLastWriteTime_.has_value() && writeTime <= rulesLastWriteTime_.value()) {
      return;
    }

    std::string error;
    if (!wildpaw::room::loadCombatRuleProfilesFromJson(rulesPath_, &error)) {
      ruleReloadFailureTotal_.fetch_add(1, std::memory_order_relaxed);
      std::cerr << "[room] rules hot-reload failed: " << error
                << " path=" << rulesPath_ << '\n';
      return;
    }

    rulesLastWriteTime_ = writeTime;
    ruleReloadSuccessTotal_.fetch_add(1, std::memory_order_relaxed);

    std::cout << "[room] rules hot-reloaded from " << rulesPath_
              << " defaultProfile="
              << wildpaw::room::defaultCombatRuleProfileId() << '\n';
  }

  void tickOnce() {
    using clock = std::chrono::steady_clock;
    const auto tickStart = clock::now();

    maybeReloadRules();

    const auto drainedInputs = drainPendingInputs();

    wildpaw::room::WorldSnapshot worldSnapshot;
    wildpaw::room::SnapshotDelta deltaSnapshot;
    std::vector<wildpaw::room::CombatEvent> combatEvents;
    std::vector<wildpaw::room::ProjectileEvent> projectileEvents;

    {
      std::lock_guard<std::mutex> lock(simulationMutex_);

      for (const auto& pending : drainedInputs) {
        simulation_.pushInput(pending.playerId, pending.input);
      }

      worldSnapshot = simulation_.tick();
      deltaSnapshot = snapshotBuilder_.buildDelta(worldSnapshot);
      combatEvents = simulation_.drainCombatEvents();
      projectileEvents = simulation_.drainProjectileEvents();
    }

    tickTotal_.fetch_add(1, std::memory_order_relaxed);

    const std::uint64_t serverTimeMs = unixTimeMs();

    auto sessions = snapshotSessions();

    const bool needInterestFiltering =
        !sessions.empty() &&
        (!deltaSnapshot.changedPlayers.empty() ||
         !deltaSnapshot.removedPlayerIds.empty() || !combatEvents.empty() ||
         !projectileEvents.empty());

    std::unordered_map<std::uint32_t, std::unordered_set<std::uint32_t>>
        visibleIdsByPlayer;

    if (needInterestFiltering) {
      interestManager_.rebuild(worldSnapshot.players, 8.0f);
      visibleIdsByPlayer.reserve(sessions.size());

      for (const auto& [playerId, _] : sessions) {
        const auto visiblePlayers = interestManager_.filterFor(playerId, 25.0f);
        visibleIdsByPlayer.emplace(playerId, makeVisibleIdSet(visiblePlayers));
      }
    }

    for (const auto& [playerId, session] : sessions) {
      const auto visibleFound = visibleIdsByPlayer.find(playerId);
      if (visibleFound == visibleIdsByPlayer.end()) {
        continue;
      }

      const auto& visibleIds = visibleFound->second;

      const auto visibleChanged =
          selectVisibleChangedPlayers(deltaSnapshot, visibleIds);

      if (!visibleChanged.empty() || !deltaSnapshot.removedPlayerIds.empty()) {
        const auto meta = session->nextEnvelopeMeta();
        auto payload = wildpaw::room::wire::encodeSnapshotEnvelope(
            true, deltaSnapshot.serverTick, serverTimeMs, visibleChanged,
            deltaSnapshot.removedPlayerIds, meta);
        session->sendBinary(std::move(payload));
        snapshotDeltaSentTotal_.fetch_add(1, std::memory_order_relaxed);
      }

      for (const auto& combatEvent : combatEvents) {
        if (!shouldSendCombatEvent(playerId, visibleIds, combatEvent)) {
          combatEventFilteredTotal_.fetch_add(1, std::memory_order_relaxed);
          continue;
        }

        const auto meta = session->nextEnvelopeMeta();
        auto payload =
            wildpaw::room::wire::encodeCombatEventEnvelope(combatEvent, meta);
        session->sendBinary(std::move(payload));
        combatEventSentTotal_.fetch_add(1, std::memory_order_relaxed);
      }

      for (const auto& projectileEvent : projectileEvents) {
        if (!shouldSendProjectileEvent(playerId, visibleIds, projectileEvent)) {
          projectileEventFilteredTotal_.fetch_add(1, std::memory_order_relaxed);
          continue;
        }

        const auto meta = session->nextEnvelopeMeta();
        auto payload = wildpaw::room::wire::encodeProjectileEventEnvelope(
            projectileEvent, meta);
        session->sendBinary(std::move(payload));
        projectileEventSentTotal_.fetch_add(1, std::memory_order_relaxed);
      }
    }

    for (const auto& [_, session] : sessions) {
      session->pumpRetransmit();
    }

    const auto tickElapsed =
        std::chrono::duration_cast<std::chrono::microseconds>(clock::now() - tickStart)
            .count();
    lastTickDurationMicros_.store(static_cast<std::uint64_t>(tickElapsed),
                                  std::memory_order_relaxed);

    if (tickElapsed > static_cast<long long>(tickIntervalMs_) * 1000LL) {
      tickOverrunTotal_.fetch_add(1, std::memory_order_relaxed);
    }

    if (worldSnapshot.serverTick % simulation_.tickRate() == 0) {
      std::cout << "[room] tick=" << worldSnapshot.serverTick
                << " activePlayers=" << worldSnapshot.players.size()
                << " changedPlayers=" << deltaSnapshot.changedPlayers.size()
                << " drainedInputs=" << drainedInputs.size()
                << " droppedInputs="
                << droppedInputFrames_.load(std::memory_order_relaxed)
                << " reliableInFlight=" << reliableInFlightTotal() << '\n';
    }
  }

  net::io_context& io_;
  tcp::acceptor acceptor_;
  std::uint16_t wsPort_{0};

  wildpaw::room::RoomSimulation simulation_;
  wildpaw::room::SnapshotBuilder snapshotBuilder_;
  wildpaw::room::InterestManager interestManager_;

  int tickIntervalMs_{33};

  std::uint16_t teamSize_{3};
  std::size_t maxPlayersPerRoom_{6};

  std::string rulesPath_;
  std::filesystem::path mapDataRootPath_;
  std::string roomTokenSecret_;

  std::optional<std::filesystem::file_time_type> rulesLastWriteTime_;
  std::chrono::steady_clock::time_point nextRuleReloadCheckAt_{};

  static constexpr std::uint32_t kSoloPracticeDummyPlayerId = 9000001;

  std::mutex roomRuntimeMutex_;
  std::string activeMatchId_;
  std::string activeMapId_;
  std::uint64_t activeRoomExpiresAtMs_{0};
  bool soloPracticeMode_{false};
  bool soloPracticeDummySpawned_{false};

  std::atomic<bool> running_{false};
  std::jthread tickThread_;

  std::mutex sessionsMutex_;
  std::unordered_map<std::uint32_t, std::shared_ptr<WsSession>> sessions_;
  std::unordered_map<std::uint32_t, TeamAssignment> teamAssignments_;

  std::mutex violationsMutex_;
  std::deque<ViolationEvent> violations_;

  std::mutex simulationMutex_;

  std::mutex pendingInputMutex_;
  std::deque<PendingInput> pendingInputs_;

  std::atomic<std::uint64_t> droppedInputFrames_{0};
  std::atomic<std::uint64_t> pendingInputQueuePeak_{0};
  std::atomic<std::uint64_t> inputFramesTotal_{0};

  std::atomic<std::uint64_t> tickTotal_{0};
  std::atomic<std::uint64_t> tickOverrunTotal_{0};
  std::atomic<std::uint64_t> lastTickDurationMicros_{0};

  std::atomic<std::uint64_t> snapshotBaseSentTotal_{0};
  std::atomic<std::uint64_t> snapshotDeltaSentTotal_{0};
  std::atomic<std::uint64_t> eventSentTotal_{0};
  std::atomic<std::uint64_t> combatEventSentTotal_{0};
  std::atomic<std::uint64_t> projectileEventSentTotal_{0};
  std::atomic<std::uint64_t> combatEventFilteredTotal_{0};
  std::atomic<std::uint64_t> projectileEventFilteredTotal_{0};
  std::atomic<std::uint64_t> ruleReloadSuccessTotal_{0};
  std::atomic<std::uint64_t> ruleReloadFailureTotal_{0};

  std::atomic<std::uint64_t> retransmitSentTotal_{0};
  std::atomic<std::uint64_t> retransmitDroppedTotal_{0};

  std::uint32_t nextPlayerId_{1001};
};

void WsSession::noteClientEnvelope(const wildpaw::room::wire::EnvelopeMeta& meta) {
  {
    std::lock_guard<std::mutex> lock(reliabilityMutex_);
    reliability_.onClientPacket(meta.seq, meta.ack, meta.ackBits);
  }

  // 클라이언트 ack를 반영한 직후 재전송 큐를 정리/재전송.
  pumpRetransmit();
}

void WsSession::pumpRetransmit() {
  using clock = std::chrono::steady_clock;

  std::vector<std::vector<std::uint8_t>> retransmitPayloads;
  std::size_t dropped = 0;

  {
    std::scoped_lock lock(reliabilityMutex_, reliableQueueMutex_);

    const auto now = clock::now();
    auto it = reliableQueue_.begin();

    while (it != reliableQueue_.end()) {
      if (reliability_.wasServerPacketAcked(it->sequence)) {
        it = reliableQueue_.erase(it);
        continue;
      }

      if (it->timeout.count() <= 0) {
        it = reliableQueue_.erase(it);
        continue;
      }

      if (now - it->lastSent >= it->timeout) {
        if (it->retries >= it->maxRetries) {
          it = reliableQueue_.erase(it);
          ++dropped;
          continue;
        }

        it->lastSent = now;
        ++it->retries;
        retransmitPayloads.push_back(it->payload);
      }

      ++it;
    }
  }

  if (!retransmitPayloads.empty()) {
    server_.addRetransmitSent(retransmitPayloads.size());
    for (auto& payload : retransmitPayloads) {
      sendBinary(std::move(payload));
    }
  }

  if (dropped > 0) {
    server_.addRetransmitDropped(dropped);
  }
}

void WsSession::start() {
  ws_.set_option(
      websocket::stream_base::timeout::suggested(beast::role_type::server));
  ws_.set_option(websocket::stream_base::decorator(
      [](websocket::response_type& response) {
        response.set(beast::http::field::server, "wildpaw-room/0.8");
      }));

  // 보호: 지나치게 큰 메시지(악성/버그)를 즉시 끊는다.
  ws_.read_message_max(64 * 1024);

  auto self = shared_from_this();
  ws_.async_accept([self](beast::error_code ec) {
    if (ec) {
      self->onClosed(ec);
      return;
    }

    self->doRead();
  });
}

void WsSession::doRead() {
  auto self = shared_from_this();
  ws_.async_read(readBuffer_, [self](beast::error_code ec, std::size_t) {
    if (ec) {
      if (ec == websocket::error::message_too_big) {
        self->server_.recordViolation(self->playerId_, self->remoteEndpoint(),
                                      "message_too_big", ec.message());
      }

      self->onClosed(ec);
      return;
    }

    const std::size_t bytes = beast::buffer_bytes(self->readBuffer_.data());

    if (self->ws_.got_text()) {
      self->noteTextFrame(bytes);
      self->server_.recordViolation(self->playerId_, self->remoteEndpoint(),
                                    "c2s_text_frame",
                                    "text frame received (binary-only)");

      self->readBuffer_.consume(self->readBuffer_.size());

      const auto meta = self->nextEnvelopeMeta();
      auto eventPayload = wildpaw::room::wire::encodeEventEnvelope(
          "warn", "binary-c2s-required", meta);
      self->sendBinary(std::move(eventPayload));

      self->doRead();
      return;
    }

    std::vector<std::uint8_t> payload(bytes);
    if (!payload.empty()) {
      net::buffer_copy(net::buffer(payload), self->readBuffer_.data());
    }
    self->readBuffer_.consume(self->readBuffer_.size());

    self->noteBinaryFrame(payload.size());
    self->server_.onSessionBinaryMessage(self->playerId_, payload);
    self->doRead();
  });
}

void WsSession::sendBinary(std::vector<std::uint8_t> payload) {
  bytesOut_.fetch_add(payload.size(), std::memory_order_relaxed);
  binaryFramesOut_.fetch_add(1, std::memory_order_relaxed);

  auto self = shared_from_this();
  net::post(ws_.get_executor(),
            [self, payload = std::move(payload)]() mutable {
              const bool writing = !self->writeQueue_.empty();
              self->writeQueue_.push_back(std::move(payload));

              if (!writing) {
                self->doWrite();
              }
            });
}

void WsSession::sendReliableBinary(std::uint32_t sequence,
                                   std::vector<std::uint8_t> payload,
                                   ReliableClass reliableClass) {
  using clock = std::chrono::steady_clock;

  if (reliableClass == ReliableClass::None) {
    sendBinary(std::move(payload));
    return;
  }

  const auto policy = policyFor(reliableClass);

  bool dropped = false;
  {
    std::lock_guard<std::mutex> lock(reliableQueueMutex_);

    if (reliableQueue_.size() >= kMaxReliableQueue) {
      reliableQueue_.pop_front();
      dropped = true;
    }

    reliableQueue_.push_back(ReliablePacket{
        .sequence = sequence,
        .payload = payload,
        .lastSent = clock::now(),
        .retries = 0,
        .maxRetries = policy.maxRetries,
        .timeout = policy.timeout,
        .reliableClass = reliableClass,
    });
  }

  if (dropped) {
    server_.addRetransmitDropped(1);
  }

  sendBinary(std::move(payload));
}

void WsSession::requestClose(std::string_view reason) {
  auto self = shared_from_this();
  net::post(ws_.get_executor(), [self, reasonStr = std::string{reason}]() mutable {
    if (self->closed_ || self->closing_) {
      return;
    }

    self->closeRequested_ = true;
    if (!reasonStr.empty()) {
      self->closeReason_ = std::move(reasonStr);
    }

    if (self->writeQueue_.empty()) {
      self->doCloseNow();
    }
  });
}

void WsSession::doCloseNow() {
  if (closed_ || closing_) {
    return;
  }

  closing_ = true;

  websocket::close_reason closeReason;
  closeReason.code = websocket::close_code::normal;
  closeReason.reason = closeReason_.empty() ? "closed" : closeReason_;

  auto self = shared_from_this();
  ws_.async_close(closeReason, [self](beast::error_code ec) {
    self->onClosed(ec);
  });
}

void WsSession::doWrite() {
  auto self = shared_from_this();
  ws_.binary(true);

  ws_.async_write(net::buffer(writeQueue_.front()),
                  [self](beast::error_code ec, std::size_t) {
                    if (ec) {
                      self->onClosed(ec);
                      return;
                    }

                    self->writeQueue_.pop_front();
                    if (!self->writeQueue_.empty()) {
                      self->doWrite();
                    } else if (self->closeRequested_) {
                      self->doCloseNow();
                    }
                  });
}

void WsSession::onClosed(const beast::error_code& ec) {
  if (closed_) {
    return;
  }
  closed_ = true;

  if (ec != websocket::error::closed) {
    std::cerr << "[room] session(" << playerId_ << ") closed: " << ec.message()
              << '\n';
  }

  server_.onSessionClosed(playerId_);
}

class AdminHttpSession : public std::enable_shared_from_this<AdminHttpSession> {
 public:
  using JsonRenderer = std::function<std::string()>;
  using DisconnectHandler = std::function<bool(std::uint32_t)>;
  using ReloadHandler = std::function<bool(std::string*)>;

  AdminHttpSession(tcp::socket socket,
                   JsonRenderer renderMetrics,
                   JsonRenderer renderStatus,
                   JsonRenderer renderSessions,
                   JsonRenderer renderViolations,
                   DisconnectHandler disconnectSession,
                   ReloadHandler reloadRules,
                   std::string adminToken)
      : socket_(std::move(socket)),
        renderMetrics_(std::move(renderMetrics)),
        renderStatus_(std::move(renderStatus)),
        renderSessions_(std::move(renderSessions)),
        renderViolations_(std::move(renderViolations)),
        disconnectSession_(std::move(disconnectSession)),
        reloadRules_(std::move(reloadRules)),
        adminToken_(std::move(adminToken)) {}

  void start() { doRead(); }

 private:
  static constexpr std::string_view kAdminHtml = R"HTML(<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Wildpaw Admin Dashboard</title>
  <style>
    :root {
      --bg: #0b1020;
      --card: #151b33;
      --border: #243057;
      --text: #d7def7;
      --muted: #98a4cf;
      --good: #5ddf98;
      --warn: #ffd16a;
      --bad: #ff8f7a;
      --accent: #7ce7ff;
      --accent2: #c58bff;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
    }

    h1, h2, h3 { margin: 0 0 8px; }
    h1 { font-size: 22px; margin-bottom: 14px; }
    h2 { font-size: 17px; }
    h3 { font-size: 13px; color: var(--muted); font-weight: 600; }

    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .grid { display: grid; gap: 12px; }
    .grid.kpi { grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); margin-top: 12px; }
    .grid.two-col { grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); margin-top: 12px; }

    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.02) inset;
    }

    input, button, select {
      background: #1a2448;
      color: var(--text);
      border: 1px solid #2a3b74;
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 13px;
    }

    input::placeholder { color: #8ea0d1; }
    button { cursor: pointer; }
    button:hover { filter: brightness(1.08); }

    .kpi-value { font-size: 24px; font-weight: 700; line-height: 1.1; }
    .kpi-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }

    .status-chip {
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 12px;
      border: 1px solid #2a3b74;
      background: #1a2448;
    }
    .status-chip.good { color: var(--good); border-color: #327a57; }
    .status-chip.warn { color: var(--warn); border-color: #7b6a34; }
    .status-chip.bad { color: var(--bad); border-color: #7f4a40; }

    .chart-canvas {
      width: 100%;
      height: 220px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: #0f1530;
      display: block;
    }

    .legend { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; font-size: 12px; color: var(--muted); }
    .legend i { width: 10px; height: 10px; display: inline-block; border-radius: 999px; margin-right: 4px; }

    .bar-wrap { display: grid; gap: 10px; margin-top: 8px; }
    .bar-row { display: grid; grid-template-columns: 60px 1fr 50px; align-items: center; gap: 8px; font-size: 12px; }
    .bar-track { height: 10px; background: #0f1530; border: 1px solid #243057; border-radius: 999px; overflow: hidden; }
    .bar-fill { height: 100%; }

    .table-tools { margin: 8px 0 10px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #243057; padding: 7px 6px; font-size: 13px; text-align: left; vertical-align: top; }
    th { color: #a8b5df; font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; }

    .team-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      border-radius: 999px;
      padding: 2px 8px;
      border: 1px solid #2a3b74;
      background: #1a2448;
    }
    .dot { width: 8px; height: 8px; border-radius: 999px; display: inline-block; }

    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .muted { color: var(--muted); }

    .tree details { margin: 6px 0; }
    .tree summary { cursor: pointer; color: #c9d5fb; }
    .tree ul { margin: 6px 0 0 18px; padding: 0; }
    .tree li { margin: 3px 0; }

    pre {
      white-space: pre-wrap;
      background: #0f1530;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px;
      max-height: 280px;
      overflow: auto;
      margin: 0;
    }

    .section-space { margin-top: 12px; }
  </style>
</head>
<body>
  <h1>Wildpaw Room Admin Dashboard</h1>

  <div class="card row">
    <label>Admin Token <input id="token" type="password" placeholder="x-admin-token" /></label>
    <button id="refresh">Refresh</button>
    <button id="reload">Rules Reload</button>
    <label>Auto
      <select id="autoRefreshSec">
        <option value="0">off</option>
        <option value="1">1s</option>
        <option value="2" selected>2s</option>
        <option value="5">5s</option>
      </select>
    </label>
    <span id="statusMsg" class="status-chip">idle</span>
  </div>

  <div class="grid kpi">
    <div class="card"><h3>Active Sessions</h3><div id="kpiActiveSessions" class="kpi-value">-</div><div class="kpi-sub">현재 접속 플레이어</div></div>
    <div class="card"><h3>Match / Map</h3><div id="kpiMatchMap" class="kpi-value mono" style="font-size:15px;">-</div><div class="kpi-sub">매치/맵 격리 상태</div></div>
    <div class="card"><h3>Tick</h3><div id="kpiTick" class="kpi-value">-</div><div id="kpiTickSub" class="kpi-sub">-</div></div>
    <div class="card"><h3>Input / Drop</h3><div id="kpiInput" class="kpi-value">-</div><div id="kpiDropSub" class="kpi-sub">-</div></div>
    <div class="card"><h3>Retransmit</h3><div id="kpiRetransmit" class="kpi-value">-</div><div id="kpiRetransmitSub" class="kpi-sub">-</div></div>
  </div>

  <div class="grid two-col">
    <div class="card">
      <h2>실시간 지표 (최근 60 샘플)</h2>
      <canvas id="metricsChart" class="chart-canvas" width="900" height="220"></canvas>
      <div class="legend">
        <span><i style="background:var(--accent)"></i>tick duration (ms)</span>
        <span><i style="background:var(--accent2)"></i>reliable inflight</span>
        <span><i style="background:var(--warn)"></i>active sessions</span>
      </div>
    </div>

    <div class="card">
      <h2>팀 점유 / 용량</h2>
      <div class="bar-wrap">
        <div class="bar-row">
          <span>Team 1</span>
          <div class="bar-track"><div id="barTeam1" class="bar-fill" style="width:0%;background:#7ce7ff"></div></div>
          <span id="labelTeam1" class="mono">0</span>
        </div>
        <div class="bar-row">
          <span>Team 2</span>
          <div class="bar-track"><div id="barTeam2" class="bar-fill" style="width:0%;background:#ffc36a"></div></div>
          <span id="labelTeam2" class="mono">0</span>
        </div>
      </div>
      <div id="capacitySummary" class="kpi-sub" style="margin-top:10px;">-</div>
    </div>
  </div>

  <div class="card section-space">
    <h2>Sessions (표)</h2>
    <div class="row table-tools">
      <input id="sessionFilter" placeholder="playerId / remote 필터" />
      <span class="muted" id="sessionCountLabel">0 sessions</span>
    </div>
    <table>
      <thead>
        <tr>
          <th>player</th>
          <th>team</th>
          <th>remote</th>
          <th>traffic (in/out)</th>
          <th>last seen</th>
          <th>invalid</th>
          <th>action</th>
        </tr>
      </thead>
      <tbody id="sessions"></tbody>
    </table>
  </div>

  <div class="card section-space">
    <h2>Violations (트리)</h2>
    <div id="violationsTree" class="tree muted">loading...</div>
  </div>

  <details class="card section-space">
    <summary>Raw JSON (debug)</summary>
    <div class="grid two-col" style="margin-top:10px;">
      <div>
        <h3>Status</h3>
        <pre id="rawStatus">-</pre>
      </div>
      <div>
        <h3>Sessions / Violations</h3>
        <pre id="rawOthers">-</pre>
      </div>
    </div>
  </details>

  <script>
    const q = (s) => document.querySelector(s);
    const tokenEl = q('#token');
    const msgEl = q('#statusMsg');
    const autoRefreshEl = q('#autoRefreshSec');
    const sessionFilterEl = q('#sessionFilter');
    const TOKEN_STORAGE_KEY = 'wildpaw-admin-token';

    const historyState = {
      maxPoints: 60,
      points: [],
    };

    let autoRefreshTimer = null;

    function initToken() {
      const queryToken = new URLSearchParams(window.location.search).get('token') || '';
      if (queryToken) {
        tokenEl.value = queryToken;
        return;
      }

      try {
        const stored = window.localStorage.getItem(TOKEN_STORAGE_KEY) || '';
        if (stored) tokenEl.value = stored;
      } catch {
        // ignore
      }
    }

    function persistToken() {
      try {
        if (tokenEl.value) window.localStorage.setItem(TOKEN_STORAGE_KEY, tokenEl.value);
        else window.localStorage.removeItem(TOKEN_STORAGE_KEY);
      } catch {
        // ignore
      }
    }

    function headers() {
      return tokenEl.value ? { 'x-admin-token': tokenEl.value } : {};
    }

    function withTokenQuery(path) {
      if (!tokenEl.value) return path;
      try {
        const url = new URL(path, window.location.origin);
        if (!url.searchParams.has('token')) url.searchParams.set('token', tokenEl.value);
        return `${url.pathname}${url.search}`;
      } catch {
        return path;
      }
    }

    async function api(path, options = {}) {
      const res = await fetch(withTokenQuery(path), {
        ...options,
        headers: { ...(options.headers || {}), ...headers() },
      });
      if (!res.ok) throw new Error(`${path} ${res.status}`);
      const ct = res.headers.get('content-type') || '';
      return ct.includes('application/json') ? res.json() : res.text();
    }

    function fmtNum(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
      return value.toLocaleString();
    }

    function fmtSince(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '-';
      const diff = Date.now() - ms;
      if (diff < 1000) return 'just now';
      if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
      if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
      return `${Math.round(diff / 3_600_000)}h ago`;
    }

    function setStatusChip(text, tier = 'good') {
      msgEl.textContent = text;
      msgEl.className = `status-chip ${tier}`;
    }

    function pushHistory(status) {
      const metrics = status?.metrics || {};
      historyState.points.push({
        at: Date.now(),
        tickMs: Number(metrics.tickLastDurationMs ?? 0),
        inflight: Number(metrics.reliableInFlight ?? 0),
        activeSessions: Number(metrics.activeSessions ?? 0),
      });
      if (historyState.points.length > historyState.maxPoints) {
        historyState.points.shift();
      }
    }

    function drawChart() {
      const canvas = q('#metricsChart');
      const ctx = canvas.getContext('2d');
      const points = historyState.points;
      const w = canvas.width;
      const h = canvas.height;

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#0f1530';
      ctx.fillRect(0, 0, w, h);

      const pad = { l: 40, r: 12, t: 12, b: 24 };
      const cw = w - pad.l - pad.r;
      const ch = h - pad.t - pad.b;

      ctx.strokeStyle = '#243057';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i += 1) {
        const y = pad.t + (ch * i) / 4;
        ctx.beginPath();
        ctx.moveTo(pad.l, y);
        ctx.lineTo(pad.l + cw, y);
        ctx.stroke();
      }

      if (points.length < 2) return;

      const maxTickMs = Math.max(1, ...points.map((p) => p.tickMs));
      const maxInflight = Math.max(1, ...points.map((p) => p.inflight));
      const maxSessions = Math.max(1, ...points.map((p) => p.activeSessions));

      function drawSeries(color, accessor, maxValue) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        points.forEach((p, i) => {
          const x = pad.l + (cw * i) / (points.length - 1);
          const y = pad.t + ch - (ch * accessor(p)) / maxValue;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }

      drawSeries('#7ce7ff', (p) => p.tickMs, maxTickMs);
      drawSeries('#c58bff', (p) => p.inflight, maxInflight);
      drawSeries('#ffd16a', (p) => p.activeSessions, maxSessions);

      ctx.fillStyle = '#98a4cf';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText(`tickMs max ${maxTickMs.toFixed(3)}`, 8, 16);
      ctx.fillText(`inflight max ${maxInflight}`, 8, 30);
      ctx.fillText(`sessions max ${maxSessions}`, 8, 44);
    }

    function renderKpi(status) {
      const metrics = status?.metrics || {};
      q('#kpiActiveSessions').textContent = fmtNum(metrics.activeSessions);
      q('#kpiMatchMap').textContent = `${status?.activeMatchId || '-'} / ${status?.activeMapId || '-'}`;
      q('#kpiTick').textContent = `${fmtNum(status?.currentTick)} @${fmtNum(status?.tickRate)}Hz`;
      q('#kpiTickSub').textContent = `tickLast=${Number(metrics.tickLastDurationMs ?? 0).toFixed(3)}ms, overrun=${fmtNum(metrics.tickOverrunTotal)}`;
      q('#kpiInput').textContent = `${fmtNum(metrics.inputFramesTotal)} / ${fmtNum(metrics.pendingInputDepth)}`;
      q('#kpiDropSub').textContent = `dropped=${fmtNum(metrics.droppedInputFramesTotal)}, peak=${fmtNum(metrics.pendingInputPeak)}`;
      q('#kpiRetransmit').textContent = `${fmtNum(metrics.retransmitSentTotal)} / ${fmtNum(metrics.retransmitDroppedTotal)}`;
      q('#kpiRetransmitSub').textContent = `inflight=${fmtNum(metrics.reliableInFlight)}`;
    }

    function renderTeamBars(status) {
      const occ = status?.teamOccupancy || {};
      const team1 = Number(occ.team1 ?? 0);
      const team2 = Number(occ.team2 ?? 0);
      const maxPlayers = Number(status?.maxPlayersPerRoom ?? 1);
      const teamCap = Math.max(1, Math.floor(maxPlayers / 2));

      q('#barTeam1').style.width = `${Math.min(100, (team1 / teamCap) * 100)}%`;
      q('#barTeam2').style.width = `${Math.min(100, (team2 / teamCap) * 100)}%`;
      q('#labelTeam1').textContent = `${team1}/${teamCap}`;
      q('#labelTeam2').textContent = `${team2}/${teamCap}`;
      q('#capacitySummary').textContent = `active ${team1 + team2}/${maxPlayers} · roomExpiresAt ${status?.activeRoomExpiresAtMs || 0}`;
    }

    function renderSessionsTable(sessionsPayload) {
      const list = Array.isArray(sessionsPayload?.sessions) ? sessionsPayload.sessions : [];
      const filter = (sessionFilterEl.value || '').trim().toLowerCase();
      const tbody = q('#sessions');
      tbody.innerHTML = '';

      const filtered = list.filter((s) => {
        if (!filter) return true;
        const hay = `${s.playerId} ${s.remote || ''}`.toLowerCase();
        return hay.includes(filter);
      });

      q('#sessionCountLabel').textContent = `${filtered.length} sessions`;

      for (const s of filtered) {
        const tr = document.createElement('tr');
        const teamColor = Number(s.teamId) === 1 ? '#7ce7ff' : '#ffc36a';

        tr.innerHTML = `
          <td class="mono">${s.playerId}</td>
          <td><span class="team-badge"><i class="dot" style="background:${teamColor}"></i>T${s.teamId}-S${s.teamSlot}</span></td>
          <td class="mono">${s.remote || '-'}</td>
          <td class="mono">${fmtNum(s.bytesIn)} / ${fmtNum(s.bytesOut)}<br><span class="muted">frames ${fmtNum(s.binaryFramesIn)} text ${fmtNum(s.textFramesIn)}</span></td>
          <td class="mono">${fmtSince(s.lastSeenAtMs)}<br><span class="muted">${s.lastSeenAtMs}</span></td>
          <td class="mono">${fmtNum(s.invalidEnvelopeTotal)} / ${fmtNum(s.unsupportedMessageTotal)} / ${fmtNum(s.invalidProfileSelectTotal)}</td>
          <td><button data-id="${s.playerId}">disconnect</button></td>
        `;

        tr.querySelector('button').onclick = async () => {
          try {
            await api(`/admin/api/sessions/${s.playerId}/disconnect`, { method: 'POST' });
            setStatusChip(`disconnected ${s.playerId}`, 'warn');
            await refresh();
          } catch (error) {
            setStatusChip(`disconnect failed: ${error.message}`, 'bad');
          }
        };

        tbody.appendChild(tr);
      }
    }

    function renderViolationsTree(violationsPayload) {
      const list = Array.isArray(violationsPayload?.violations) ? violationsPayload.violations : [];
      const root = q('#violationsTree');
      root.innerHTML = '';

      if (list.length === 0) {
        root.textContent = 'No violations ✅';
        root.classList.remove('muted');
        return;
      }

      root.classList.remove('muted');

      const byType = new Map();
      for (const item of list) {
        const type = item.type || 'unknown';
        if (!byType.has(type)) byType.set(type, []);
        byType.get(type).push(item);
      }

      const sortedTypes = [...byType.entries()].sort((a, b) => b[1].length - a[1].length);
      for (const [type, entries] of sortedTypes) {
        const typeNode = document.createElement('details');
        typeNode.open = sortedTypes.length <= 3;
        const typeSummary = document.createElement('summary');
        typeSummary.innerHTML = `<span class="mono">${type}</span> <span class="muted">(${entries.length})</span>`;
        typeNode.appendChild(typeSummary);

        const byPlayer = new Map();
        for (const e of entries) {
          const key = String(e.playerId ?? '-');
          if (!byPlayer.has(key)) byPlayer.set(key, []);
          byPlayer.get(key).push(e);
        }

        const playerList = document.createElement('ul');
        const sortedPlayers = [...byPlayer.entries()].sort((a, b) => b[1].length - a[1].length);

        for (const [playerId, pe] of sortedPlayers) {
          const li = document.createElement('li');
          const detail = document.createElement('details');
          const summary = document.createElement('summary');
          summary.innerHTML = `<span class="mono">player ${playerId}</span> <span class="muted">(${pe.length})</span>`;
          detail.appendChild(summary);

          const inner = document.createElement('ul');
          for (const ev of pe.slice(-8).reverse()) {
            const row = document.createElement('li');
            row.className = 'mono';
            row.textContent = `${ev.timeMs} · ${ev.remote || '-'} · ${ev.detail || ''}`;
            inner.appendChild(row);
          }
          detail.appendChild(inner);
          li.appendChild(detail);
          playerList.appendChild(li);
        }

        typeNode.appendChild(playerList);
        root.appendChild(typeNode);
      }
    }

    async function refresh() {
      try {
        setStatusChip('loading...', 'warn');

        const [status, sessions, violations] = await Promise.all([
          api('/admin/api/status'),
          api('/admin/api/sessions'),
          api('/admin/api/violations'),
        ]);

        renderKpi(status);
        renderTeamBars(status);
        renderSessionsTable(sessions);
        renderViolationsTree(violations);

        pushHistory(status);
        drawChart();

        q('#rawStatus').textContent = JSON.stringify(status, null, 2);
        q('#rawOthers').textContent = JSON.stringify({ sessions, violations }, null, 2);

        setStatusChip('ok', 'good');
      } catch (error) {
        setStatusChip(`error: ${error.message}`, 'bad');
      }
    }

    function applyAutoRefresh() {
      if (autoRefreshTimer !== null) {
        window.clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
      }

      const sec = Number(autoRefreshEl.value || 0);
      if (Number.isFinite(sec) && sec > 0) {
        autoRefreshTimer = window.setInterval(refresh, sec * 1000);
      }
    }

    q('#refresh').onclick = refresh;
    q('#reload').onclick = async () => {
      try {
        const result = await api('/admin/api/rules/reload', { method: 'POST' });
        setStatusChip(result?.ok ? 'rules reloaded' : JSON.stringify(result), result?.ok ? 'good' : 'warn');
        await refresh();
      } catch (error) {
        setStatusChip(`reload failed: ${error.message}`, 'bad');
      }
    };

    tokenEl.addEventListener('input', () => {
      persistToken();
      refresh();
    });

    autoRefreshEl.addEventListener('change', applyAutoRefresh);
    sessionFilterEl.addEventListener('input', () => {
      const raw = q('#rawOthers').textContent;
      try {
        const parsed = JSON.parse(raw);
        renderSessionsTable(parsed.sessions || {});
      } catch {
        // ignore
      }
    });

    initToken();
    persistToken();
    applyAutoRefresh();
    refresh();
  </script>
</body>
</html>)HTML";

  void doRead() {
    auto self = shared_from_this();
    http::async_read(socket_, buffer_, request_,
                     [self](beast::error_code ec, std::size_t) {
                       if (ec) {
                         return;
                       }
                       self->doWrite();
                     });
  }

  bool authorizeAdmin(std::string_view query) const {
    if (adminToken_.empty()) {
      return true;
    }

    if (auto it = request_.find("x-admin-token"); it != request_.end()) {
      if (it->value() == adminToken_) {
        return true;
      }
    }

    const auto token = getQueryParam(query, "token");
    return token.has_value() && *token == adminToken_;
  }

  static bool parseDisconnectPath(std::string_view path, std::uint32_t& playerIdOut) {
    constexpr std::string_view kPrefix = "/admin/api/sessions/";
    constexpr std::string_view kSuffix = "/disconnect";

    if (!path.starts_with(kPrefix) || !path.ends_with(kSuffix)) {
      return false;
    }

    const auto idView =
        path.substr(kPrefix.size(), path.size() - kPrefix.size() - kSuffix.size());
    if (idView.empty()) {
      return false;
    }

    std::uint32_t parsed = 0;
    const auto* begin = idView.data();
    const auto* end = idView.data() + idView.size();
    const auto [ptr, ec] = std::from_chars(begin, end, parsed);
    if (ec != std::errc{} || ptr != end) {
      return false;
    }

    playerIdOut = parsed;
    return true;
  }

  std::shared_ptr<http::response<http::string_body>> makeTextResponse(
      http::status status,
      std::string body,
      std::string_view contentType,
      std::string_view serverTag = "wildpaw-admin") {
    auto response = std::make_shared<http::response<http::string_body>>(
        status, request_.version());
    response->set(http::field::server, serverTag);
    response->set(http::field::content_type, contentType);
    response->keep_alive(false);
    response->body() = std::move(body);
    response->prepare_payload();
    return response;
  }

  void doWrite() {
    const auto method = request_.method();
    std::string_view query;
    const auto target = std::string_view{request_.target()};
    const auto path = stripQuery(target, &query);

    std::shared_ptr<http::response<http::string_body>> response;

    if (method == http::verb::get && path == "/metrics") {
      response = makeTextResponse(http::status::ok, renderMetrics_(),
                                  "text/plain; version=0.0.4; charset=utf-8",
                                  "wildpaw-metrics");
    } else if (path.starts_with("/admin")) {
      if (!authorizeAdmin(query)) {
        response = makeTextResponse(http::status::unauthorized,
                                    "{\"ok\":false,\"error\":\"unauthorized\"}",
                                    "application/json; charset=utf-8");
      } else if (method == http::verb::get && (path == "/admin" || path == "/admin/")) {
        response = makeTextResponse(http::status::ok, std::string{kAdminHtml},
                                    "text/html; charset=utf-8");
      } else if (method == http::verb::get && path == "/admin/api/status") {
        response = makeTextResponse(http::status::ok, renderStatus_(),
                                    "application/json; charset=utf-8");
      } else if (method == http::verb::get && path == "/admin/api/sessions") {
        response = makeTextResponse(http::status::ok, renderSessions_(),
                                    "application/json; charset=utf-8");
      } else if (method == http::verb::get && path == "/admin/api/violations") {
        response = makeTextResponse(http::status::ok, renderViolations_(),
                                    "application/json; charset=utf-8");
      } else if (method == http::verb::post && path == "/admin/api/rules/reload") {
        std::string error;
        const bool ok = reloadRules_(&error);
        if (ok) {
          response = makeTextResponse(
              http::status::ok,
              "{\"ok\":true,\"message\":\"rules reloaded\"}",
              "application/json; charset=utf-8");
        } else {
          response = makeTextResponse(
              http::status::bad_request,
              std::string{"{\"ok\":false,\"error\":\""} + jsonEscape(error) +
                  "\"}",
              "application/json; charset=utf-8");
        }
      } else if (method == http::verb::post &&
                 path.starts_with("/admin/api/sessions/") &&
                 path.ends_with("/disconnect")) {
        std::uint32_t playerId = 0;
        if (!parseDisconnectPath(path, playerId)) {
          response = makeTextResponse(
              http::status::bad_request,
              "{\"ok\":false,\"error\":\"invalid player id\"}",
              "application/json; charset=utf-8");
        } else {
          const bool ok = disconnectSession_(playerId);
          if (ok) {
            response = makeTextResponse(
                http::status::ok,
                "{\"ok\":true,\"message\":\"disconnect requested\"}",
                "application/json; charset=utf-8");
          } else {
            response = makeTextResponse(
                http::status::not_found,
                "{\"ok\":false,\"error\":\"session not found\"}",
                "application/json; charset=utf-8");
          }
        }
      } else {
        response = makeTextResponse(http::status::not_found,
                                    "{\"ok\":false,\"error\":\"not found\"}",
                                    "application/json; charset=utf-8");
      }
    } else {
      response = makeTextResponse(http::status::not_found,
                                  "{\"ok\":false,\"error\":\"not found\"}",
                                  "application/json; charset=utf-8");
    }

    auto self = shared_from_this();
    http::async_write(
        socket_, *response,
        [self, response](beast::error_code, std::size_t) {
          beast::error_code ignored;
          self->socket_.shutdown(tcp::socket::shutdown_send, ignored);
        });
  }

  tcp::socket socket_;
  beast::flat_buffer buffer_;
  http::request<http::string_body> request_;

  JsonRenderer renderMetrics_;
  JsonRenderer renderStatus_;
  JsonRenderer renderSessions_;
  JsonRenderer renderViolations_;
  DisconnectHandler disconnectSession_;
  ReloadHandler reloadRules_;
  std::string adminToken_;
};

class MetricsServer {
 public:
  MetricsServer(net::io_context& io,
                const tcp::endpoint& endpoint,
                std::function<std::string()> renderMetrics,
                std::function<std::string()> renderStatus,
                std::function<std::string()> renderSessions,
                std::function<std::string()> renderViolations,
                std::function<bool(std::uint32_t)> disconnectSession,
                std::function<bool(std::string*)> reloadRules,
                std::string adminToken)
      : io_(io),
        acceptor_(net::make_strand(io)),
        renderMetrics_(std::move(renderMetrics)),
        renderStatus_(std::move(renderStatus)),
        renderSessions_(std::move(renderSessions)),
        renderViolations_(std::move(renderViolations)),
        disconnectSession_(std::move(disconnectSession)),
        reloadRules_(std::move(reloadRules)),
        adminToken_(std::move(adminToken)) {
    beast::error_code ec;

    acceptor_.open(endpoint.protocol(), ec);
    if (ec) {
      throw beast::system_error(ec);
    }

    acceptor_.set_option(net::socket_base::reuse_address(true), ec);
    if (ec) {
      throw beast::system_error(ec);
    }

    acceptor_.bind(endpoint, ec);
    if (ec) {
      throw beast::system_error(ec);
    }

    acceptor_.listen(net::socket_base::max_listen_connections, ec);
    if (ec) {
      throw beast::system_error(ec);
    }
  }

  void start() {
    if (running_.exchange(true)) {
      return;
    }
    doAccept();
  }

  void stop() {
    if (!running_.exchange(false)) {
      return;
    }

    net::dispatch(acceptor_.get_executor(), [this]() {
      beast::error_code ec;
      acceptor_.cancel(ec);
      acceptor_.close(ec);
    });
  }

 private:
  void doAccept() {
    if (!running_.load(std::memory_order_relaxed)) {
      return;
    }

    acceptor_.async_accept(net::make_strand(io_),
                           [this](beast::error_code ec, tcp::socket socket) {
                             if (!ec) {
                               std::make_shared<AdminHttpSession>(
                                   std::move(socket), renderMetrics_,
                                   renderStatus_, renderSessions_,
                                   renderViolations_, disconnectSession_,
                                   reloadRules_, adminToken_)
                                   ->start();
                             } else if (ec != net::error::operation_aborted) {
                               std::cerr << "[metrics] accept failed: " << ec.message()
                                         << '\n';
                             }

                             if (running_.load(std::memory_order_relaxed)) {
                               doAccept();
                             }
                           });
  }

  net::io_context& io_;
  tcp::acceptor acceptor_;

  std::function<std::string()> renderMetrics_;
  std::function<std::string()> renderStatus_;
  std::function<std::string()> renderSessions_;
  std::function<std::string()> renderViolations_;
  std::function<bool(std::uint32_t)> disconnectSession_;
  std::function<bool(std::string*)> reloadRules_;
  std::string adminToken_;

  std::atomic<bool> running_{false};
};

int main(int argc, char* argv[]) {
  try {
    const std::uint16_t port =
        argc > 1 ? static_cast<std::uint16_t>(std::stoi(argv[1])) : 7001;

    const std::size_t ioThreads =
        argc > 2 ? std::max<std::size_t>(1, static_cast<std::size_t>(std::stoul(argv[2])))
                 : std::max<std::size_t>(2, std::thread::hardware_concurrency());

    const std::uint16_t tickRate =
        argc > 3 ? static_cast<std::uint16_t>(std::max(1, std::stoi(argv[3]))) : 30;

    const std::uint16_t metricsPort =
        argc > 4 ? static_cast<std::uint16_t>(std::stoi(argv[4])) : 9100;

    const std::string rulesPath =
        argc > 5 ? std::string{argv[5]} : "room/config/combat_rules.json";

    const std::uint16_t teamSize =
        argc > 6 ? static_cast<std::uint16_t>(std::max(1, std::stoi(argv[6])))
                 : 3;

    const std::filesystem::path mapDataRootPath =
        argc > 7 ? std::filesystem::path{argv[7]}
                 : std::filesystem::path{"../client/web/src/level/data/maps"};

    const std::string roomTokenSecret = []() {
      const char* env = std::getenv("WILDPAW_ROOM_TOKEN_SECRET");
      if (env == nullptr || std::string_view{env}.empty()) {
        return std::string{"dev-room-secret"};
      }
      return std::string{env};
    }();

    std::string rulesError;
    if (!wildpaw::room::loadCombatRuleProfilesFromJson(rulesPath, &rulesError)) {
      std::cerr << "[room] combat rule load failed, fallback to built-in profiles: "
                << rulesError << " path=" << rulesPath << '\n';
    }

    const std::string adminToken = []() {
      const char* env = std::getenv("WILDPAW_ADMIN_TOKEN");
      if (env == nullptr) {
        return std::string{};
      }
      return std::string{env};
    }();

    net::io_context io;
    auto workGuard = net::make_work_guard(io);

    RoomServer roomServer(io, tcp::endpoint(tcp::v4(), port), tickRate,
                          teamSize, rulesPath, mapDataRootPath,
                          roomTokenSecret);
    MetricsServer metricsServer(
        io, tcp::endpoint(tcp::v4(), metricsPort),
        [&roomServer]() { return roomServer.renderPrometheusMetrics(); },
        [&roomServer]() { return roomServer.renderAdminStatusJson(); },
        [&roomServer]() { return roomServer.renderAdminSessionsJson(); },
        [&roomServer]() { return roomServer.renderAdminViolationsJson(); },
        [&roomServer](std::uint32_t playerId) {
          return roomServer.disconnectSession(playerId);
        },
        [&roomServer](std::string* error) {
          return roomServer.reloadRulesNow(error);
        },
        adminToken);

    roomServer.start();
    metricsServer.start();

    net::signal_set signals(io, SIGINT, SIGTERM);
    signals.async_wait([&](const beast::error_code&, int signalNumber) {
      std::cout << "[room] received signal " << signalNumber << ", shutting down\n";
      roomServer.stop();
      metricsServer.stop();
      workGuard.reset();
      io.stop();
    });

    std::vector<std::thread> threads;
    threads.reserve(ioThreads);

    for (std::size_t i = 0; i < ioThreads; ++i) {
      threads.emplace_back([&io]() { io.run(); });
    }

    std::cout << "[room] websocket server listening on 0.0.0.0:" << port
              << " ioThreads=" << ioThreads << " tickRate=" << tickRate
              << " metricsPort=" << metricsPort
              << " rulesPath=" << rulesPath
              << " teamSize=" << teamSize
              << " maxPlayersPerRoom=" << (static_cast<std::uint32_t>(teamSize) * 2u)
              << " mapDataRootPath=" << mapDataRootPath.string()
              << " roomTokenAuth=" << (roomTokenSecret.empty() ? "off" : "on")
              << " defaultProfile="
              << wildpaw::room::defaultCombatRuleProfileId()
              << " adminAuth=" << (adminToken.empty() ? "off" : "on") << '\n';

    for (auto& thread : threads) {
      thread.join();
    }
  } catch (const std::exception& exception) {
    std::cerr << "[room] fatal: " << exception.what() << '\n';
    return 1;
  }

  return 0;
}
