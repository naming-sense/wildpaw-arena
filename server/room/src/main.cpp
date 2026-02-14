#include <asio.hpp>

#include <chrono>
#include <csignal>
#include <functional>
#include <iostream>
#include <memory>

#include "room/room_simulation.hpp"
#include "room/snapshot_builder.hpp"

int main() {
  using namespace std::chrono_literals;

  asio::io_context io;
  asio::signal_set signals(io, SIGINT, SIGTERM);

  wildpaw::room::RoomSimulation simulation(30);
  wildpaw::room::SnapshotBuilder snapshotBuilder;

  // TODO: 실제 구현에서는 gateway 할당 정보 기반으로 플레이어 생성.
  simulation.addPlayer(1001);
  simulation.addPlayer(1002);

  auto timer = std::make_shared<asio::steady_timer>(io);
  const auto tickInterval = 33ms;

  auto loop = std::make_shared<std::function<void()>>();
  *loop = [&]() {
    timer->expires_after(tickInterval);
    timer->async_wait([&, loop](const asio::error_code& ec) {
      if (ec) {
        return;
      }

      auto snapshot = simulation.tick();
      auto delta = snapshotBuilder.buildDelta(snapshot);

      if (snapshot.serverTick % simulation.tickRate() == 0) {
        std::cout << "[room] tick=" << snapshot.serverTick
                  << " players=" << snapshot.players.size()
                  << " deltaPlayers=" << delta.changedPlayers.size()
                  << '\n';
      }

      (*loop)();
    });
  };

  signals.async_wait([&](const asio::error_code&, int signalNumber) {
    std::cout << "[room] received signal " << signalNumber << ", shutting down\n";
    io.stop();
  });

  std::cout << "[room] started (30Hz). Press Ctrl+C to exit.\n";
  (*loop)();
  io.run();

  return 0;
}
