import { listLevelMapIds, loadLevelMapDefinition } from "../src/level/data/levelLoader";
import { validateLevelMapDefinition } from "../src/level/data/levelValidator";

function main(): void {
  const mapIds = listLevelMapIds();
  let hasError = false;

  for (const mapId of mapIds) {
    try {
      const map = loadLevelMapDefinition(mapId);
      const result = validateLevelMapDefinition(map);

      if (!result.ok) {
        hasError = true;
        console.error(`\n[level:validate] FAIL map=${mapId}`);
        for (const error of result.errors) {
          console.error(`  - ${error}`);
        }
        continue;
      }

      console.log(`\n[level:validate] OK map=${mapId}`);
      if (result.warnings.length > 0) {
        for (const warning of result.warnings) {
          console.log(`  ! ${warning}`);
        }
      } else {
        console.log("  ! no warnings");
      }
    } catch (error) {
      hasError = true;
      console.error(`\n[level:validate] ERROR map=${mapId}`);
      console.error(error);
    }
  }

  if (hasError) {
    process.exitCode = 1;
    return;
  }

  console.log("\n[level:validate] all maps passed ✅");
}

main();
