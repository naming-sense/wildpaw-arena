#include "room/room_simulation.hpp"

#include <algorithm>
#include <cmath>

namespace wildpaw::room {

namespace {
constexpr float kPlayerSpeedMps = 4.0f;
constexpr float kWorldBoundary = 50.0f;
}  // namespace

RoomSimulation::RoomSimulation(std::uint32_t tickRate)
    : tickRate_(tickRate), inputBuffer_(256) {}

void RoomSimulation::addPlayer(std::uint32_t playerId) {
  PlayerState state;
  state.playerId = playerId;

  // 단순 스폰 분산: 초기 중첩을 피하기 위해 원형 배치.
  const float ringRadius = 3.0f;
  const float angle = static_cast<float>((players_.size() % 12) * (3.1415926535 / 6.0));
  state.position = {ringRadius * std::cos(angle), ringRadius * std::sin(angle)};
  state.velocity = {0.0f, 0.0f};

  players_[playerId] = state;
}

void RoomSimulation::removePlayer(std::uint32_t playerId) {
  players_.erase(playerId);
  frameInputs_.erase(playerId);
}

void RoomSimulation::pushInput(std::uint32_t playerId, const InputFrame& frame) {
  inputBuffer_.push(playerId, frame);
}

WorldSnapshot RoomSimulation::tick() {
  ++tick_;

  collectInputs();
  applyMovement();
  processCombat();

  return collectSnapshot();
}

WorldSnapshot RoomSimulation::snapshot() const {
  return collectSnapshot();
}

void RoomSimulation::collectInputs() {
  for (auto& [playerId, player] : players_) {
    auto latest = inputBuffer_.latest(playerId);
    if (latest.has_value()) {
      frameInputs_[playerId] = latest.value();
      player.lastProcessedInputSeq = latest->inputSeq;
    } else if (!frameInputs_.contains(playerId)) {
      frameInputs_[playerId] = InputFrame{};
    }
  }
}

void RoomSimulation::applyMovement() {
  const float dt = 1.0f / static_cast<float>(tickRate_);

  for (auto& [playerId, player] : players_) {
    if (!player.alive) {
      continue;
    }

    const auto inputFound = frameInputs_.find(playerId);
    if (inputFound == frameInputs_.end()) {
      continue;
    }

    const auto& input = inputFound->second;
    player.velocity.x = static_cast<float>(input.moveX) * kPlayerSpeedMps;
    player.velocity.y = static_cast<float>(input.moveY) * kPlayerSpeedMps;

    player.position.x += player.velocity.x * dt;
    player.position.y += player.velocity.y * dt;

    player.position.x = std::clamp(player.position.x, -kWorldBoundary, kWorldBoundary);
    player.position.y = std::clamp(player.position.y, -kWorldBoundary, kWorldBoundary);
  }
}

void RoomSimulation::processCombat() {
  // TODO: M2에서 히트스캔/투사체 authoritative 판정으로 교체.
  for (auto& [playerId, player] : players_) {
    const auto inputFound = frameInputs_.find(playerId);
    if (inputFound == frameInputs_.end()) {
      continue;
    }

    if (inputFound->second.firing) {
      // 임시: 발사 플래그만 사용하고 실제 피해는 적용하지 않음.
      (void)player;
    }
  }
}

WorldSnapshot RoomSimulation::collectSnapshot() const {
  WorldSnapshot snapshot;
  snapshot.serverTick = tick_;
  snapshot.players.reserve(players_.size());

  for (const auto& [_, player] : players_) {
    snapshot.players.push_back(player);
  }

  return snapshot;
}

}  // namespace wildpaw::room
