#include <boost/asio.hpp>
#include <boost/beast.hpp>
#include <boost/beast/websocket.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <deque>
#include <iostream>
#include <memory>
#include <mutex>
#include <span>
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
namespace net = boost::asio;
using tcp = net::ip::tcp;

namespace {

std::uint64_t unixTimeMs() {
  using namespace std::chrono;
  return static_cast<std::uint64_t>(
      duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

std::vector<wildpaw::room::PlayerState> selectVisibleChangedPlayers(
    const wildpaw::room::SnapshotDelta& delta,
    const std::vector<wildpaw::room::PlayerState>& visiblePlayers) {
  if (delta.changedPlayers.empty() || visiblePlayers.empty()) {
    return {};
  }

  std::unordered_set<std::uint32_t> visibleIds;
  visibleIds.reserve(visiblePlayers.size());
  for (const auto& player : visiblePlayers) {
    visibleIds.insert(player.playerId);
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
  void sendBinary(std::vector<std::uint8_t> payload);

  void noteClientEnvelope(const wildpaw::room::wire::EnvelopeMeta& meta) {
    std::lock_guard<std::mutex> lock(reliabilityMutex_);
    reliability_.onClientPacket(meta.seq, meta.ack, meta.ackBits);
  }

  [[nodiscard]] wildpaw::room::wire::EnvelopeMeta nextEnvelopeMeta() {
    std::lock_guard<std::mutex> lock(reliabilityMutex_);

    const std::uint32_t seq = reliability_.nextServerSequence();
    const auto& ackState = reliability_.outboundAckState();

    wildpaw::room::wire::EnvelopeMeta meta;
    meta.seq = seq;
    meta.ack = ackState.ack;
    meta.ackBits = ackState.ackBits;
    return meta;
  }

  [[nodiscard]] std::uint32_t playerId() const { return playerId_; }

 private:
  void doRead();
  void doWrite();
  void onClosed(const beast::error_code& ec);

  websocket::stream<beast::tcp_stream> ws_;
  beast::flat_buffer readBuffer_;
  std::deque<std::vector<std::uint8_t>> writeQueue_;

  RoomServer& server_;
  std::uint32_t playerId_{0};
  wildpaw::room::RoomSession reliability_;
  std::mutex reliabilityMutex_;

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

    session->sendBinary(wildpaw::room::wire::encodeWelcomeEnvelope(
        playerId, simulation_.tickRate(), simulation_.currentTick(),
        session->nextEnvelopeMeta()));

    session->sendBinary(wildpaw::room::wire::encodeSnapshotEnvelope(
        false, baseSnapshot.serverTick, unixTimeMs(), baseSnapshot.players,
        session->nextEnvelopeMeta()));

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
      session->sendBinary(wildpaw::room::wire::encodeEventEnvelope(
          "warn", "invalid-envelope", session->nextEnvelopeMeta()));
      return;
    }

    session->noteClientEnvelope(decoded->meta);

    switch (decoded->type) {
      case wildpaw::room::wire::ClientMessageType::Hello:
        session->sendBinary(wildpaw::room::wire::encodeWelcomeEnvelope(
            playerId, simulation_.tickRate(), simulation_.currentTick(),
            session->nextEnvelopeMeta()));
        return;

      case wildpaw::room::wire::ClientMessageType::Input:
        enqueueInput(playerId, decoded->input);
        return;

      case wildpaw::room::wire::ClientMessageType::Ping:
        session->sendBinary(wildpaw::room::wire::encodeEventEnvelope(
            "pong", "ok", session->nextEnvelopeMeta()));
        return;

      default:
        session->sendBinary(wildpaw::room::wire::encodeEventEnvelope(
            "warn", "unsupported-message-type", session->nextEnvelopeMeta()));
        return;
    }
  }

  void onSessionClosed(std::uint32_t playerId) {
    {
      std::lock_guard<std::mutex> lock(sessionsMutex_);
      auto found = sessions_.find(playerId);
      if (found != sessions_.end()) {
        sessions_.erase(found);
      }
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
    auto found = sessions_.find(playerId);
    if (found == sessions_.end()) {
      return nullptr;
    }
    return found->second;
  }

  [[nodiscard]] std::size_t activeSessionCount() {
    std::lock_guard<std::mutex> lock(sessionsMutex_);
    return sessions_.size();
  }

  void enqueueInput(std::uint32_t playerId, const wildpaw::room::InputFrame& input) {
    std::lock_guard<std::mutex> lock(pendingInputMutex_);

    if (pendingInputs_.size() >= kMaxPendingInputFrames) {
      pendingInputs_.pop_front();
      ++droppedInputFrames_;
    }

    pendingInputs_.push_back(PendingInput{.playerId = playerId, .input = input});
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
    if (!running_.load()) {
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

                             if (running_.load()) {
                               doAccept();
                             }
                           });
  }

  void startTickThread() {
    tickThread_ = std::jthread([this](std::stop_token stopToken) {
      using clock = std::chrono::steady_clock;
      auto next = clock::now();

      while (running_.load() && !stopToken.stop_requested()) {
        next += std::chrono::milliseconds(tickIntervalMs_);
        tickOnce();
        std::this_thread::sleep_until(next);
      }
    });
  }

  void tickOnce() {
    const auto drainedInputs = drainPendingInputs();

    wildpaw::room::WorldSnapshot worldSnapshot;
    wildpaw::room::SnapshotDelta deltaSnapshot;

    {
      std::lock_guard<std::mutex> lock(simulationMutex_);

      for (const auto& pending : drainedInputs) {
        simulation_.pushInput(pending.playerId, pending.input);
      }

      worldSnapshot = simulation_.tick();
      deltaSnapshot = snapshotBuilder_.buildDelta(worldSnapshot);
    }

    const std::uint64_t serverTimeMs = unixTimeMs();

    if (!deltaSnapshot.changedPlayers.empty()) {
      auto sessions = snapshotSessions();

      for (const auto& [playerId, session] : sessions) {
        const auto visiblePlayers =
            interestManager_.filterFor(playerId, worldSnapshot.players, 25.0f);
        const auto visibleChanged =
            selectVisibleChangedPlayers(deltaSnapshot, visiblePlayers);

        if (visibleChanged.empty()) {
          continue;
        }

        session->sendBinary(wildpaw::room::wire::encodeSnapshotEnvelope(
            true, deltaSnapshot.serverTick, serverTimeMs, visibleChanged,
            session->nextEnvelopeMeta()));
      }
    }

    if (worldSnapshot.serverTick % simulation_.tickRate() == 0) {
      std::cout << "[room] tick=" << worldSnapshot.serverTick
                << " activePlayers=" << worldSnapshot.players.size()
                << " changedPlayers=" << deltaSnapshot.changedPlayers.size()
                << " drainedInputs=" << drainedInputs.size()
                << " droppedInputs=" << droppedInputFrames_.load() << '\n';
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

  std::uint32_t nextPlayerId_{1001};
};

void WsSession::start() {
  ws_.set_option(
      websocket::stream_base::timeout::suggested(beast::role_type::server));
  ws_.set_option(websocket::stream_base::decorator(
      [](websocket::response_type& response) {
        response.set(beast::http::field::server, "wildpaw-room/0.6");
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
      self->sendBinary(wildpaw::room::wire::encodeEventEnvelope(
          "warn", "binary-c2s-required", self->nextEnvelopeMeta()));
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

int main(int argc, char* argv[]) {
  try {
    const std::uint16_t port =
        argc > 1 ? static_cast<std::uint16_t>(std::stoi(argv[1])) : 7001;

    const std::size_t ioThreads =
        argc > 2 ? std::max<std::size_t>(1, static_cast<std::size_t>(std::stoul(argv[2])))
                 : std::max<std::size_t>(2, std::thread::hardware_concurrency());

    const std::uint16_t tickRate =
        argc > 3 ? static_cast<std::uint16_t>(std::max(1, std::stoi(argv[3]))) : 30;

    net::io_context io;
    auto workGuard = net::make_work_guard(io);

    net::signal_set signals(io, SIGINT, SIGTERM);

    RoomServer server(io, tcp::endpoint(tcp::v4(), port), tickRate);
    server.start();

    signals.async_wait([&](const beast::error_code&, int signalNumber) {
      std::cout << "[room] received signal " << signalNumber << ", shutting down\n";
      server.stop();
      workGuard.reset();
      io.stop();
    });

    std::vector<std::thread> threads;
    threads.reserve(ioThreads);

    for (std::size_t i = 0; i < ioThreads; ++i) {
      threads.emplace_back([&io]() { io.run(); });
    }

    std::cout << "[room] websocket server listening on 0.0.0.0:" << port
              << " ioThreads=" << ioThreads << " tickRate=" << tickRate << '\n';

    for (auto& thread : threads) {
      thread.join();
    }
  } catch (const std::exception& exception) {
    std::cerr << "[room] fatal: " << exception.what() << '\n';
    return 1;
  }

  return 0;
}
