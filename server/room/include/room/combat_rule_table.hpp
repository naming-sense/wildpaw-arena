#pragma once

#include <cstdint>

namespace wildpaw::room {

struct SkillRule {
  std::uint32_t cooldownTicks{0};
  std::uint32_t castTimeTicks{0};
  float rangeMeters{0.0f};
  float radiusMeters{0.0f};
  std::uint16_t damage{0};
  std::uint16_t ammoCost{0};
  bool critical{false};
};

struct CombatRuleTable {
  std::uint16_t maxAmmo{0};
  std::uint16_t ammoPerShot{1};
  std::uint32_t fireIntervalTicks{1};
  std::uint32_t reloadTicks{0};
  float shotRangeMeters{0.0f};
  std::uint16_t shotDamage{0};
  float projectileSpeed{0.0f};

  SkillRule skillQ{};
  SkillRule skillE{};
  SkillRule skillR{};
};

// 임시 스캐폴드용 기본 룰 테이블.
const CombatRuleTable& defaultCombatRuleTable();

}  // namespace wildpaw::room
