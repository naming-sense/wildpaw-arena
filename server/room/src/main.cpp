#include <boost/asio.hpp>
#include <boost/beast.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/websocket.hpp>

#include <algorithm>
#include <atomic>
#include <charconv>
#include <chrono>
#include <csignal>
#include <cstdlib>
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
  std::string closeReason_;
};

class RoomServer {
 public:
  RoomServer(net::io_context& io,
             const tcp::endpoint& endpoint,
             std::uint16_t tickRate,
             std::uint16_t teamSize,
             std::string rulesPath)
      : io_(io),
        acceptor_(net::make_strand(io)),
        wsPort_(endpoint.port()),
        simulation_(tickRate),
        tickIntervalMs_(std::max<int>(1, 1000 / static_cast<int>(tickRate))),
        teamSize_(normalizeTeamSize(teamSize)),
        maxPlayersPerRoom_(static_cast<std::size_t>(teamSize_) * 2u),
        rulesPath_(std::move(rulesPath)) {
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
    out << "\"teamOccupancy\":{";
    out << "\"team1\":" << teamOneCount << ',';
    out << "\"team2\":" << teamTwoCount;
    out << "},";
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

  bool onSessionReady(const std::shared_ptr<WsSession>& session) {
    const std::uint32_t playerId = session->playerId();

    TeamAssignment assignment;
    bool accepted = false;

    {
      std::lock_guard<std::mutex> lock(sessionsMutex_);

      if (sessions_.size() < maxPlayersPerRoom_) {
        const auto reserved = allocateTeamAssignmentLocked();
        if (reserved.has_value()) {
          assignment = reserved.value();
          sessions_[playerId] = session;
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
      simulation_.addPlayer(playerId);
      baseSnapshot = simulation_.snapshot();
    }

    const auto welcomeMeta = session->nextEnvelopeMeta();
    auto welcomePayload = wildpaw::room::wire::encodeWelcomeEnvelope(
        playerId, simulation_.tickRate(), simulation_.currentTick(), welcomeMeta);
    session->sendReliableBinary(welcomeMeta.seq, std::move(welcomePayload),
                                WsSession::ReliableClass::Critical);

    const auto baseMeta = session->nextEnvelopeMeta();
    auto basePayload = wildpaw::room::wire::encodeSnapshotEnvelope(
        false, baseSnapshot.serverTick, unixTimeMs(), baseSnapshot.players, baseMeta);
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
              << maxPlayersPerRoom_ << '\n';

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

    switch (decoded->type) {
      case wildpaw::room::wire::ClientMessageType::Hello:
        sendEventWithPolicy(session, "hello.ack", "ok",
                            WsSession::ReliableClass::Standard);
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
    {
      std::lock_guard<std::mutex> lock(sessionsMutex_);
      sessions_.erase(playerId);
      teamAssignments_.erase(playerId);
    }

    {
      std::lock_guard<std::mutex> lock(simulationMutex_);
      simulation_.removePlayer(playerId);
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
    return sessions_.size();
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

    if (sessions_.size() >= maxPlayersPerRoom_) {
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
        (!deltaSnapshot.changedPlayers.empty() || !combatEvents.empty() ||
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

      if (!deltaSnapshot.changedPlayers.empty()) {
        const auto visibleChanged =
            selectVisibleChangedPlayers(deltaSnapshot, visibleIds);

        if (!visibleChanged.empty()) {
          const auto meta = session->nextEnvelopeMeta();
          auto payload = wildpaw::room::wire::encodeSnapshotEnvelope(
              true, deltaSnapshot.serverTick, serverTimeMs, visibleChanged, meta);
          session->sendBinary(std::move(payload));
          snapshotDeltaSentTotal_.fetch_add(1, std::memory_order_relaxed);
        }
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
  std::optional<std::filesystem::file_time_type> rulesLastWriteTime_;
  std::chrono::steady_clock::time_point nextRuleReloadCheckAt_{};

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

    if (self->server_.onSessionReady(self)) {
      self->doRead();
    }
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
  <title>Wildpaw Admin</title>
  <style>
    body { font-family: ui-sans-serif, system-ui; margin: 16px; background:#0b1020; color:#d7def7; }
    h1,h2 { margin: 8px 0; }
    .row { display:flex; gap:12px; flex-wrap:wrap; align-items:center; margin-bottom:10px; }
    .card { background:#151b33; border:1px solid #243057; border-radius:10px; padding:12px; }
    input,button { background:#1a2448; color:#d7def7; border:1px solid #2a3b74; border-radius:8px; padding:6px 10px; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #243057; padding:6px; font-size:13px; text-align:left; }
    pre { white-space:pre-wrap; background:#0f1530; border:1px solid #243057; border-radius:8px; padding:8px; }
  </style>
</head>
<body>
  <h1>Wildpaw Room Admin</h1>
  <div class="row card">
    <label>Admin Token <input id="token" type="password" placeholder="x-admin-token" /></label>
    <button id="refresh">Refresh</button>
    <button id="reload">Rules Reload</button>
    <span id="statusMsg"></span>
  </div>

  <div class="card">
    <h2>Overview</h2>
    <pre id="overview">loading...</pre>
  </div>

  <div class="card" style="margin-top:12px;">
    <h2>Sessions</h2>
    <table>
      <thead><tr><th>playerId</th><th>team</th><th>remote</th><th>bytesIn/out</th><th>lastSeen</th><th>invalid</th><th>action</th></tr></thead>
      <tbody id="sessions"></tbody>
    </table>
  </div>

  <div class="card" style="margin-top:12px;">
    <h2>Violations</h2>
    <pre id="violations">loading...</pre>
  </div>

  <script>
    const q = (s) => document.querySelector(s);
    const tokenEl = q('#token');
    const msgEl = q('#statusMsg');
    const TOKEN_STORAGE_KEY = 'wildpaw-admin-token';

    function initToken() {
      const queryToken = new URLSearchParams(window.location.search).get('token') || '';
      if (queryToken) {
        tokenEl.value = queryToken;
        return;
      }

      try {
        const stored = window.localStorage.getItem(TOKEN_STORAGE_KEY) || '';
        if (stored) {
          tokenEl.value = stored;
        }
      } catch {
        // ignore storage failures
      }
    }

    function persistToken() {
      try {
        if (tokenEl.value) {
          window.localStorage.setItem(TOKEN_STORAGE_KEY, tokenEl.value);
        } else {
          window.localStorage.removeItem(TOKEN_STORAGE_KEY);
        }
      } catch {
        // ignore storage failures
      }
    }

    tokenEl.addEventListener('input', persistToken);
    initToken();
    persistToken();

    const headers = () => tokenEl.value ? {'x-admin-token': tokenEl.value} : {};

    function withTokenQuery(path) {
      if (!tokenEl.value) {
        return path;
      }

      try {
        const url = new URL(path, window.location.origin);
        if (!url.searchParams.has('token')) {
          url.searchParams.set('token', tokenEl.value);
        }
        return `${url.pathname}${url.search}`;
      } catch {
        return path;
      }
    }

    async function api(path, options = {}) {
      const res = await fetch(withTokenQuery(path), { ...options, headers: { ...(options.headers||{}), ...headers() } });
      if (!res.ok) throw new Error(path + ' ' + res.status);
      const ct = res.headers.get('content-type') || '';
      return ct.includes('application/json') ? res.json() : res.text();
    }

    async function refresh() {
      try {
        const [status, sessions, violations] = await Promise.all([
          api('/admin/api/status'),
          api('/admin/api/sessions'),
          api('/admin/api/violations'),
        ]);

        q('#overview').textContent = JSON.stringify(status, null, 2);

        const tbody = q('#sessions');
        tbody.innerHTML = '';
        for (const s of sessions.sessions || []) {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>${s.playerId}</td>
            <td>T${s.teamId}-S${s.teamSlot}</td>
            <td>${s.remote}</td>
            <td>${s.bytesIn}/${s.bytesOut}</td>
            <td>${s.lastSeenAtMs}</td>
            <td>${s.invalidEnvelopeTotal}/${s.unsupportedMessageTotal}/${s.invalidProfileSelectTotal}</td>
            <td><button data-id="${s.playerId}">disconnect</button></td>
          `;
          tr.querySelector('button').onclick = async () => {
            try {
              await api(`/admin/api/sessions/${s.playerId}/disconnect`, { method:'POST' });
              msgEl.textContent = `disconnected ${s.playerId}`;
              await refresh();
            } catch (e) {
              msgEl.textContent = 'disconnect failed: ' + e.message;
            }
          };
          tbody.appendChild(tr);
        }

        q('#violations').textContent = JSON.stringify(violations, null, 2);
        msgEl.textContent = 'ok';
      } catch (e) {
        msgEl.textContent = 'error: ' + e.message;
      }
    }

    q('#refresh').onclick = refresh;
    q('#reload').onclick = async () => {
      try {
        const r = await api('/admin/api/rules/reload', { method:'POST' });
        msgEl.textContent = JSON.stringify(r);
        await refresh();
      } catch (e) {
        msgEl.textContent = 'reload failed: ' + e.message;
      }
    };

    refresh();
    setInterval(refresh, 2000);
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
                          teamSize, rulesPath);
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
