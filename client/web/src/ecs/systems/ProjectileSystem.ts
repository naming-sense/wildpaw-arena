import type { EcsSystem } from "../world";

export class ProjectileSystem implements EcsSystem {
  readonly name = "ProjectileSystem";
  update(): void {
    // TODO: 투사체 오브젝트 풀 + 히트 스캔/탄도형 분리
  }
}
