#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

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

// 폴백(기본) 룰.
const CombatRuleTable& defaultCombatRuleTable();

// 외부 JSON 파일에서 프로필 룰 로드.
// 실패 시 false를 반환하며, 기존/기본 룰을 유지한다.
bool loadCombatRuleProfilesFromJson(std::string_view jsonPath,
                                    std::string* errorMessage = nullptr);

// 프로필 조회. 없으면 기본 룰 반환.
const CombatRuleTable& combatRuleForProfile(std::string_view profileId);

// 활성 프로필 목록/기본 프로필 id.
std::vector<std::string> combatRuleProfileIds();
std::string defaultCombatRuleProfileId();

}  // namespace wildpaw::room
