import type { EcsSystem } from "../world";
import { resolvePredictionStatusModifiers } from "../statusEffectModifiers";

export class SkillSystem implements EcsSystem {
  readonly name = "SkillSystem";

  update(world: import("../world").World, ctx: import("../world").SimulationContext): void {
    const skillSet = world.skills.get(ctx.localPlayerId);
    if (!skillSet || !ctx.command) return;
    if (resolvePredictionStatusModifiers(world, ctx.localPlayerId).stunned) return;

    // 입력은 즉시 연출을 위한 힌트로만 사용한다. 쿨다운/캐스팅의 최종 값은
    // GameApp이 서버 스냅샷을 받아 각 슬롯에 덮어쓴다.
    this.markPredictedCast(skillSet.q, ctx.command.skillQ, ctx.nowMs);
    this.markPredictedCast(skillSet.e, ctx.command.skillE, ctx.nowMs);
    this.markPredictedCast(skillSet.r, ctx.command.skillR, ctx.nowMs);
  }

  private markPredictedCast(
    slot: import("../components").SkillSlotState,
    requested: boolean,
    nowMs: number,
  ): void {
    if (!requested || slot.cooldownRemainingTicks > 0 || nowMs < slot.cooldownEndMs) {
      return;
    }

    // 서버 승인 전에는 새로운 쿨다운 수치를 만들지 않는다. 동일 입력이 매 틱
    // 반복 처리되는 것만 막고 다음 스냅샷이 즉시 권위 상태를 확정한다.
    slot.cooldownEndMs = nowMs + 100;
  }
}
