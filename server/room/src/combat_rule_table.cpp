#include "room/combat_rule_table.hpp"

namespace wildpaw::room {

const CombatRuleTable& defaultCombatRuleTable() {
  static const CombatRuleTable kDefault = {
      .maxAmmo = 12,
      .ammoPerShot = 1,
      .fireIntervalTicks = 4,
      .reloadTicks = 36,
      .shotRangeMeters = 12.0f,
      .shotDamage = 12,
      .projectileSpeed = 20.0f,
      .skillQ = SkillRule{
          .cooldownTicks = 30,
          .castTimeTicks = 6,
          .rangeMeters = 14.0f,
          .radiusMeters = 0.0f,
          .damage = 20,
          .ammoCost = 2,
          .critical = false,
      },
      .skillE = SkillRule{
          .cooldownTicks = 45,
          .castTimeTicks = 8,
          .rangeMeters = 0.0f,
          .radiusMeters = 0.0f,
          .damage = 0,
          .ammoCost = 1,
          .critical = false,
      },
      .skillR = SkillRule{
          .cooldownTicks = 120,
          .castTimeTicks = 20,
          .rangeMeters = 0.0f,
          .radiusMeters = 10.0f,
          .damage = 28,
          .ammoCost = 4,
          .critical = true,
      },
  };

  return kDefault;
}

}  // namespace wildpaw::room
