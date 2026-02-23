import type { RenderAnimationState } from "../components";
import type { EcsSystem, SimulationContext } from "../world";

const CLIP_FADE_SECONDS = 0.12;

export class AnimationSystem implements EcsSystem {
  readonly name = "AnimationSystem";

  update(world: import("../world").World, ctx: SimulationContext): void {
    const dtSeconds = ctx.dtMs / 1000;

    for (const [entityId, proxy] of world.renderProxies) {
      const animation = proxy.animation;
      if (!animation) continue;

      const targetClip = this.resolveTargetClip(world, entityId, animation, ctx.nowMs);

      if (targetClip !== animation.activeClip) {
        this.crossFadeTo(animation, targetClip);
      }

      animation.mixer.update(dtSeconds);
    }
  }

  private resolveTargetClip(
    world: import("../world").World,
    entityId: number,
    animation: RenderAnimationState,
    nowMs: number,
  ): string {
    if (animation.isDead) {
      return this.pickClip(animation, animation.dieClip ?? animation.idleClip);
    }

    if (animation.hitClip && nowMs < animation.hitReactUntilMs) {
      return this.pickClip(animation, animation.hitClip);
    }

    const velocity = world.velocities.get(entityId);
    const speed = velocity ? Math.hypot(velocity.x, velocity.z) : 0;
    const moving = speed > animation.moveThreshold;

    if (!moving) {
      return this.pickClip(animation, animation.idleClip);
    }

    return this.pickClip(animation, animation.runClip);
  }

  private pickClip(animation: RenderAnimationState, preferred: string): string {
    if (animation.actions.has(preferred)) {
      return preferred;
    }
    return animation.activeClip;
  }

  private crossFadeTo(animation: RenderAnimationState, targetClip: string): void {
    const next = animation.actions.get(targetClip);
    if (!next) return;

    const current = animation.actions.get(animation.activeClip);

    next.reset().fadeIn(CLIP_FADE_SECONDS).play();
    if (current && current !== next) {
      current.fadeOut(CLIP_FADE_SECONDS);
    }

    animation.activeClip = targetClip;
  }
}
