#include "room/combat_rule_table.hpp"

#include <mutex>
#include <shared_mutex>
#include <stdexcept>
#include <unordered_map>

#include <boost/property_tree/json_parser.hpp>
#include <boost/property_tree/ptree.hpp>

namespace wildpaw::room {
namespace {

CombatRuleTable makeDefaultRule() {
  return CombatRuleTable{
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
}

std::unordered_map<std::string, CombatRuleTable> makeBuiltInProfiles() {
  auto ranger = makeDefaultRule();

  auto bruiser = ranger;
  bruiser.maxAmmo = 8;
  bruiser.fireIntervalTicks = 5;
  bruiser.reloadTicks = 32;
  bruiser.shotRangeMeters = 10.0f;
  bruiser.shotDamage = 16;
  bruiser.projectileSpeed = 18.0f;
  bruiser.skillQ.cooldownTicks = 34;
  bruiser.skillQ.damage = 24;
  bruiser.skillR.cooldownTicks = 110;
  bruiser.skillR.damage = 34;
  bruiser.skillR.radiusMeters = 9.0f;

  auto skirmisher = ranger;
  skirmisher.maxAmmo = 16;
  skirmisher.fireIntervalTicks = 3;
  skirmisher.reloadTicks = 42;
  skirmisher.shotRangeMeters = 11.0f;
  skirmisher.shotDamage = 9;
  skirmisher.projectileSpeed = 23.0f;
  skirmisher.skillQ.cooldownTicks = 22;
  skirmisher.skillQ.damage = 16;
  skirmisher.skillQ.castTimeTicks = 4;
  skirmisher.skillE.cooldownTicks = 34;
  skirmisher.skillE.castTimeTicks = 5;
  skirmisher.skillR.cooldownTicks = 135;
  skirmisher.skillR.damage = 24;
  skirmisher.skillR.radiusMeters = 11.0f;

  return {
      {"ranger", ranger},
      {"bruiser", bruiser},
      {"skirmisher", skirmisher},
  };
}

CombatRuleTable gDefaultRule = makeDefaultRule();
std::unordered_map<std::string, CombatRuleTable> gProfiles = makeBuiltInProfiles();
std::string gDefaultProfileId = "ranger";
std::shared_mutex gRuleMutex;

void applySkillRule(const boost::property_tree::ptree& node, SkillRule& skill) {
  skill.cooldownTicks =
      node.get<std::uint32_t>("cooldown_ticks", skill.cooldownTicks);
  skill.castTimeTicks =
      node.get<std::uint32_t>("cast_time_ticks", skill.castTimeTicks);
  skill.rangeMeters = node.get<float>("range_meters", skill.rangeMeters);
  skill.radiusMeters = node.get<float>("radius_meters", skill.radiusMeters);
  skill.damage = node.get<std::uint16_t>("damage", skill.damage);
  skill.ammoCost = node.get<std::uint16_t>("ammo_cost", skill.ammoCost);
  skill.critical = node.get<bool>("critical", skill.critical);
}

void applyProfileRule(const boost::property_tree::ptree& node,
                      CombatRuleTable& table) {
  table.maxAmmo = node.get<std::uint16_t>("max_ammo", table.maxAmmo);
  table.ammoPerShot =
      node.get<std::uint16_t>("ammo_per_shot", table.ammoPerShot);
  table.fireIntervalTicks =
      node.get<std::uint32_t>("fire_interval_ticks", table.fireIntervalTicks);
  table.reloadTicks = node.get<std::uint32_t>("reload_ticks", table.reloadTicks);
  table.shotRangeMeters =
      node.get<float>("shot_range_meters", table.shotRangeMeters);
  table.shotDamage = node.get<std::uint16_t>("shot_damage", table.shotDamage);
  table.projectileSpeed =
      node.get<float>("projectile_speed", table.projectileSpeed);

  if (const auto maybeSkillQ = node.get_child_optional("skill_q")) {
    applySkillRule(*maybeSkillQ, table.skillQ);
  }
  if (const auto maybeSkillE = node.get_child_optional("skill_e")) {
    applySkillRule(*maybeSkillE, table.skillE);
  }
  if (const auto maybeSkillR = node.get_child_optional("skill_r")) {
    applySkillRule(*maybeSkillR, table.skillR);
  }
}

}  // namespace

CombatRuleTable defaultCombatRuleTable() { return gDefaultRule; }

bool loadCombatRuleProfilesFromJson(std::string_view jsonPath,
                                    std::string* errorMessage) {
  try {
    boost::property_tree::ptree root;
    boost::property_tree::read_json(std::string{jsonPath}, root);

    const auto profilesNode = root.get_child_optional("profiles");
    if (!profilesNode.has_value()) {
      if (errorMessage != nullptr) {
        *errorMessage = "missing `profiles` object";
      }
      return false;
    }

    std::unordered_map<std::string, CombatRuleTable> loaded;

    for (const auto& [profileId, profileNode] : *profilesNode) {
      if (profileId.empty()) {
        continue;
      }

      CombatRuleTable table = gDefaultRule;
      applyProfileRule(profileNode, table);
      loaded[profileId] = table;
    }

    if (loaded.empty()) {
      if (errorMessage != nullptr) {
        *errorMessage = "no profiles parsed from json";
      }
      return false;
    }

    std::string defaultProfile =
        root.get<std::string>("default_profile", loaded.begin()->first);
    if (!loaded.contains(defaultProfile)) {
      defaultProfile = loaded.begin()->first;
    }

    {
      std::unique_lock lock(gRuleMutex);
      gProfiles = std::move(loaded);
      gDefaultProfileId = std::move(defaultProfile);
    }

    return true;
  } catch (const std::exception& ex) {
    if (errorMessage != nullptr) {
      *errorMessage = ex.what();
    }
    return false;
  }
}

CombatRuleTable combatRuleForProfile(std::string_view profileId) {
  std::shared_lock lock(gRuleMutex);

  if (!profileId.empty()) {
    const auto found = gProfiles.find(std::string{profileId});
    if (found != gProfiles.end()) {
      return found->second;
    }
  }

  const auto foundDefault = gProfiles.find(gDefaultProfileId);
  if (foundDefault != gProfiles.end()) {
    return foundDefault->second;
  }

  return gDefaultRule;
}

std::vector<std::string> combatRuleProfileIds() {
  std::shared_lock lock(gRuleMutex);

  std::vector<std::string> ids;
  ids.reserve(gProfiles.size());

  for (const auto& [profileId, _] : gProfiles) {
    ids.push_back(profileId);
  }

  return ids;
}

std::string defaultCombatRuleProfileId() {
  std::shared_lock lock(gRuleMutex);
  return gDefaultProfileId;
}

}  // namespace wildpaw::room
