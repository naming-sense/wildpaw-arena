#include <boost/asio.hpp>
#include <boost/beast.hpp>
#include <boost/beast/websocket.hpp>

#include <algorithm>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <deque>
#include <iostream>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "room/interest_manager.hpp"
#include "room/room_simulation.hpp"
#include "room/snapshot_builder.hpp"
#include "room/wire_json.hpp"

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
      : ws_(std::move(socket)), server_(server), playerId_(playerId) {}

  void start();
  void send(std::string message);

  [[nodiscard]] std::uint32_t playerId() const { return playerId_; }

 private:
  void doRead();
  void doWrite();
  void onClosed(const beast::error_code& ec);

  websocket::stream<beast::tcp_stream> ws_;
  beast::flat_buffer readBuffer_;
  std::deque<std::string> writeQueue_;

  RoomServer& server_;
  std::uint32_t playerId_{0};
};

class RoomServer {
 public:
  RoomServer(net::io_context& io,
             const tcp::endpoint& endpoint,
             std::uint16_t tickRate)
      : io_(io),
        acceptor_(net::make_strand(io)),
        simulation_(tickRate),
        tickTimer_(io),
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

  void start() {
    doAccept();
    scheduleTick();
  }

  void onSessionReady(const std::shared_ptr<WsSession>& session) {
    const std::uint32_t playerId = session->playerId();

    sessions_[playerId] = session;
    simulation_.addPlayer(playerId);

    session->send(wildpaw::room::wire::encodeWelcome(
        playerId, simulation_.tickRate(), simulation_.currentTick()));

    const auto base = simulation_.snapshot();
    session->send(wildpaw::room::wire::encodeSnapshotBase(base, unixTimeMs()));

    std::cout << "[room] player connected: " << playerId
              << " activePlayers=" << sessions_.size() << '\n';
  }

  void onSessionMessage(std::uint32_t playerId, std::string_view raw) {
    const auto envelopeType = wildpaw::room::wire::extractEnvelopeType(raw);
    if (!envelopeType.has_value()) {
      return;
    }

    if (*envelopeType == "C2S_INPUT") {
      const auto inputFrame = wildpaw::room::wire::decodeInputEnvelope(raw);
      if (inputFrame.has_value()) {
        simulation_.pushInput(playerId, *inputFrame);
      }
      return;
    }

    auto session = getSession(playerId);
    if (!session) {
      return;
    }

    if (*envelopeType == "C2S_HELLO") {
      session->send(wildpaw::room::wire::encodeWelcome(
          playerId, simulation_.tickRate(), simulation_.currentTick()));
      return;
    }

    if (*envelopeType == "C2S_PING") {
      session->send(wildpaw::room::wire::encodeEvent("pong", "ok"));
      return;
    }

    session->send(
        wildpaw::room::wire::encodeEvent("warn", "unsupported-message-type"));
  }

  void onSessionClosed(std::uint32_t playerId) {
    auto found = sessions_.find(playerId);
    if (found == sessions_.end()) {
      return;
    }

    sessions_.erase(found);
    simulation_.removePlayer(playerId);

    std::cout << "[room] player disconnected: " << playerId
              << " activePlayers=" << sessions_.size() << '\n';
  }

 private:
  std::shared_ptr<WsSession> getSession(std::uint32_t playerId) {
    auto found = sessions_.find(playerId);
    if (found == sessions_.end()) {
      return nullptr;
    }
    return found->second;
  }

  void doAccept() {
    acceptor_.async_accept(net::make_strand(io_),
                           [this](beast::error_code ec, tcp::socket socket) {
                             if (ec) {
                               std::cerr << "[room] accept failed: " << ec.message()
                                         << '\n';
                             } else {
                               const std::uint32_t playerId = nextPlayerId_++;
                               auto session = std::make_shared<WsSession>(
                                   std::move(socket), *this, playerId);
                               session->start();
                             }

                             doAccept();
                           });
  }

  void scheduleTick() {
    tickTimer_.expires_after(std::chrono::milliseconds(tickIntervalMs_));
    tickTimer_.async_wait([this](const beast::error_code& ec) {
      if (ec) {
        return;
      }

      const auto worldSnapshot = simulation_.tick();
      const auto deltaSnapshot = snapshotBuilder_.buildDelta(worldSnapshot);
      const std::uint64_t serverTimeMs = unixTimeMs();

      if (!deltaSnapshot.changedPlayers.empty()) {
        for (const auto& [playerId, session] : sessions_) {
          const auto visiblePlayers =
              interestManager_.filterFor(playerId, worldSnapshot.players, 25.0f);
          const auto visibleChanged =
              selectVisibleChangedPlayers(deltaSnapshot, visiblePlayers);

          if (visibleChanged.empty()) {
            continue;
          }

          session->send(wildpaw::room::wire::encodeSnapshotDelta(
              deltaSnapshot, serverTimeMs, visibleChanged));
        }
      }

      if (worldSnapshot.serverTick % simulation_.tickRate() == 0) {
        std::cout << "[room] tick=" << worldSnapshot.serverTick
                  << " activePlayers=" << worldSnapshot.players.size()
                  << " changedPlayers=" << deltaSnapshot.changedPlayers.size()
                  << '\n';
      }

      scheduleTick();
    });
  }

  net::io_context& io_;
  tcp::acceptor acceptor_;

  wildpaw::room::RoomSimulation simulation_;
  wildpaw::room::SnapshotBuilder snapshotBuilder_;
  wildpaw::room::InterestManager interestManager_;

  net::steady_timer tickTimer_;
  int tickIntervalMs_{33};

  std::unordered_map<std::uint32_t, std::shared_ptr<WsSession>> sessions_;
  std::uint32_t nextPlayerId_{1001};
};

void WsSession::start() {
  ws_.set_option(
      websocket::stream_base::timeout::suggested(beast::role_type::server));
  ws_.set_option(websocket::stream_base::decorator(
      [](websocket::response_type& response) {
        response.set(beast::http::field::server, "wildpaw-room/0.2");
      }));
  ws_.text(true);

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

    const std::string payload = beast::buffers_to_string(self->readBuffer_.data());
    self->readBuffer_.consume(self->readBuffer_.size());

    self->server_.onSessionMessage(self->playerId_, payload);
    self->doRead();
  });
}

void WsSession::send(std::string message) {
  auto self = shared_from_this();
  net::post(ws_.get_executor(),
            [self, message = std::move(message)]() mutable {
              const bool writing = !self->writeQueue_.empty();
              self->writeQueue_.push_back(std::move(message));

              if (!writing) {
                self->doWrite();
              }
            });
}

void WsSession::doWrite() {
  auto self = shared_from_this();
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

    net::io_context io;
    net::signal_set signals(io, SIGINT, SIGTERM);

    RoomServer server(io, tcp::endpoint(tcp::v4(), port), 30);
    server.start();

    signals.async_wait([&](const beast::error_code&, int signalNumber) {
      std::cout << "[room] received signal " << signalNumber << ", shutting down\n";
      io.stop();
    });

    std::cout << "[room] websocket server listening on 0.0.0.0:" << port << '\n';
    io.run();
  } catch (const std::exception& exception) {
    std::cerr << "[room] fatal: " << exception.what() << '\n';
    return 1;
  }

  return 0;
}
