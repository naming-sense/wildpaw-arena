import type { LevelMapDefinition, ObjectiveDef } from "../data/levelSchema";
import { getPrefabCatalogItem } from "../prefab/prefabCatalog";
import { createMinimapProjector } from "./minimapProjector";

export interface MinimapSymbol {
  id: string;
  layer: string;
  u: number;
  v: number;
  radiusUv: number;
  color: string;
}

export interface MinimapLayerBundle {
  symbols: MinimapSymbol[];
}

function objectiveColor(objective: ObjectiveDef): string {
  switch (objective.type) {
    case "CORE":
      return "#c187ff";
    case "ZONE":
      return "#5fc5ff";
    case "PAYLOAD_PATH":
      return "#ffc067";
    case "CHECKPOINT":
      return "#ffd676";
    default:
      return "#9db2cc";
  }
}

export function buildMinimapLayers(map: LevelMapDefinition): MinimapLayerBundle {
  const projector = createMinimapProjector(map);
  const symbols: MinimapSymbol[] = [];

  for (const prefab of map.prefabs) {
    const catalog = getPrefabCatalogItem(prefab.prefabCode);
    if (!catalog) continue;

    const uv = projector.mapToUv(prefab.x, prefab.y);
    const radiusWorld = Math.max(catalog.size.x, catalog.size.z) * 0.5;
    const radiusUv = radiusWorld / Math.max(map.size.width, map.size.height);

    let color = "#7f8b9a";
    if (catalog.minimapLayer === "wall") color = "#66758a";
    if (catalog.minimapLayer === "cover") color = "#8b97a8";
    if (catalog.minimapLayer === "bush") color = "#52a36f";
    if (catalog.minimapLayer === "objective") color = "#9d8cff";
    if (catalog.minimapLayer === "path") color = "#ffc067";

    symbols.push({
      id: prefab.id,
      layer: catalog.minimapLayer,
      u: uv.u,
      v: uv.v,
      radiusUv,
      color,
    });
  }

  for (const objective of map.objectives) {
    if (objective.position) {
      const uv = projector.mapToUv(objective.position.x, objective.position.y);
      symbols.push({
        id: objective.id,
        layer: "objective",
        u: uv.u,
        v: uv.v,
        radiusUv: Math.max(0.01, (objective.radius ?? 2) / Math.max(map.size.width, map.size.height)),
        color: objectiveColor(objective),
      });
    }

    if (objective.pathNodes) {
      for (const [index, node] of objective.pathNodes.entries()) {
        const uv = projector.mapToUv(node.x, node.y);
        symbols.push({
          id: `${objective.id}:node:${index}`,
          layer: "path",
          u: uv.u,
          v: uv.v,
          radiusUv: 0.006,
          color: objectiveColor(objective),
        });
      }
    }
  }

  return { symbols };
}
