#include <boost/asio.hpp>
#include <boost/beast.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/websocket.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <deque>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <span>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

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
  WsSession(tcp::socket&& socket, RoomServer& server, std::uint32_t playerId)
      : ws_(std::move(socket)),
        server_(server),
        playerId_(playerId),
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
  void onClosed(const beast::error_code& ec);

  websocket::stream<beast::tcp_stream> ws_;
  beast::flat_buffer readBuffer_;
  std::deque<std::vector<std::uint8_t>> writeQueue_;

  RoomServer& server_;
  std::uint32_t playerId_{0};

  mutable std::mutex reliabilityMutex_;
  wildpaw::room::RoomSession reliability_;

  mutable std::mutex reliableQueueMutex_;
  std::deque<ReliablePacket> reliableQueue_;

  bool closed_{false};
};

class RoomServer {
 public:
  RoomServer(net::io_context& io,
             const tcp::endpoint& endpoint,
             std::uint16_t tickRate)
      : io_(io),
        acceptor_(net::make_strand(io)),
        simulation_(tickRate),
        tickIntervalMs_(std::max<int>(1, 1000 / static_cast<int>(tickRate))) {
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

  void onSessionReady(const std::shared_ptr<WsSession>& session) {
    const std::uint32_t playerId = session->playerId();

    {
      std::lock_guard<std::mutex> lock(sessionsMutex_);
      sessions_[playerId] = session;
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

    std::cout << "[room] player connected: " << playerId
              << " activePlayers=" << activeSessionCount() << '\n';
  }

  void onSessionBinaryMessage(std::uint32_t playerId,
                              std::span<const std::uint8_t> payload) {
    auto session = getSession(playerId);
    if (!session) {
      return;
    }

    const auto decoded = wildpaw::room::wire::decodeClientEnvelope(payload);
    if (!decoded.has_value()) {
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

      case wildpaw::room::wire::ClientMessageType::Ping:
        sendEventWithPolicy(session, "pong", "ok",
                            WsSession::ReliableClass::None);
        return;

      default:
        sendEventWithPolicy(session, "warn", "unsupported-message-type",
                            WsSession::ReliableClass::None);
        return;
    }
  }

  void onSessionClosed(std::uint32_t playerId) {
    {
      std::lock_guard<std::mutex> lock(sessionsMutex_);
      sessions_.erase(playerId);
    }

    {
      std::lock_guard<std::mutex> lock(simulationMutex_);
      simulation_.removePlayer(playerId);
    }

    std::cout << "[room] player disconnected: " << playerId
              << " activePlayers=" << activeSessionCount() << '\n';
  }

 private:
  struct PendingInput {
    std::uint32_t playerId{0};
    wildpaw::room::InputFrame input{};
  };

  static constexpr std::size_t kMaxPendingInputFrames = 100000;

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
                               const std::uint32_t playerId = nextPlayerId_++;
                               auto session = std::make_shared<WsSession>(
                                   std::move(socket), *this, playerId);
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

  void tickOnce() {
    using clock = std::chrono::steady_clock;
    const auto tickStart = clock::now();

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

  wildpaw::room::RoomSimulation simulation_;
  wildpaw::room::SnapshotBuilder snapshotBuilder_;
  wildpaw::room::InterestManager interestManager_;

  int tickIntervalMs_{33};

  std::atomic<bool> running_{false};
  std::jthread tickThread_;

  std::mutex sessionsMutex_;
  std::unordered_map<std::uint32_t, std::shared_ptr<WsSession>> sessions_;

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
        response.set(beast::http::field::server, "wildpaw-room/0.7");
      }));

  auto self = shared_from_this();
  ws_.async_accept([self](beast::error_code ec) {
    if (ec) {
      self->onClosed(ec);
      return;
    }

    self->server_.onSessionReady(self);
    self->doRead();
  });
}

void WsSession::doRead() {
  auto self = shared_from_this();
  ws_.async_read(readBuffer_, [self](beast::error_code ec, std::size_t) {
    if (ec) {
      self->onClosed(ec);
      return;
    }

    if (self->ws_.got_text()) {
      self->readBuffer_.consume(self->readBuffer_.size());

      const auto meta = self->nextEnvelopeMeta();
      auto eventPayload = wildpaw::room::wire::encodeEventEnvelope(
          "warn", "binary-c2s-required", meta);
      self->sendBinary(std::move(eventPayload));

      self->doRead();
      return;
    }

    std::vector<std::uint8_t> payload(beast::buffer_bytes(self->readBuffer_.data()));
    if (!payload.empty()) {
      net::buffer_copy(net::buffer(payload), self->readBuffer_.data());
    }
    self->readBuffer_.consume(self->readBuffer_.size());

    self->server_.onSessionBinaryMessage(self->playerId_, payload);
    self->doRead();
  });
}

void WsSession::sendBinary(std::vector<std::uint8_t> payload) {
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

class MetricsHttpSession : public std::enable_shared_from_this<MetricsHttpSession> {
 public:
  explicit MetricsHttpSession(tcp::socket socket,
                              std::function<std::string()> renderMetrics)
      : socket_(std::move(socket)), renderMetrics_(std::move(renderMetrics)) {}

  void start() { doRead(); }

 private:
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

  void doWrite() {
    auto response = std::make_shared<http::response<http::string_body>>(
        http::status::ok, request_.version());
    response->set(http::field::server, "wildpaw-metrics");
    response->set(http::field::content_type,
                  "text/plain; version=0.0.4; charset=utf-8");
    response->keep_alive(false);
    response->body() = renderMetrics_();
    response->prepare_payload();

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
  std::function<std::string()> renderMetrics_;
};

class MetricsServer {
 public:
  MetricsServer(net::io_context& io,
                const tcp::endpoint& endpoint,
                std::function<std::string()> renderMetrics)
      : io_(io),
        acceptor_(net::make_strand(io)),
        renderMetrics_(std::move(renderMetrics)) {
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
                               std::make_shared<MetricsHttpSession>(
                                   std::move(socket), renderMetrics_)
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

    net::io_context io;
    auto workGuard = net::make_work_guard(io);

    RoomServer roomServer(io, tcp::endpoint(tcp::v4(), port), tickRate);
    MetricsServer metricsServer(
        io, tcp::endpoint(tcp::v4(), metricsPort),
        [&roomServer]() { return roomServer.renderPrometheusMetrics(); });

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
              << " metricsPort=" << metricsPort << '\n';

    for (auto& thread : threads) {
      thread.join();
    }
  } catch (const std::exception& exception) {
    std::cerr << "[room] fatal: " << exception.what() << '\n';
    return 1;
  }

  return 0;
}
