import { useUiStore } from "../store/useUiStore";

function formatActiveRemainingSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0.0s";
  }

  const roundedUpSeconds = Math.ceil(seconds * 10) / 10;
  return `${roundedUpSeconds.toFixed(1)}s`;
}

function formatCooldownSeconds(seconds: number): string {
  return seconds > 0 ? formatActiveRemainingSeconds(seconds) : "READY";
}

function getCastingSkillLabel(castingSkill: 0 | 1 | 2 | 3): string | null {
  switch (castingSkill) {
    case 1:
      return "Q";
    case 2:
      return "E";
    case 3:
      return "R";
    default:
      return null;
  }
}

export function Hud(): JSX.Element {
  const {
    hp,
    maxHp,
    shield,
    heroName,
    ammo,
    maxAmmo,
    reloading,
    reloadRemainingSeconds,
    skillQCooldownSeconds,
    skillECooldownSeconds,
    skillRCooldownSeconds,
    castingSkill,
    castRemainingSeconds,
    kills,
    wave,
    fps,
    pingMs,
    packetLossPct,
    reconnectState,
    drawCalls,
  } = useUiStore();
  const castingSkillLabel = getCastingSkillLabel(castingSkill);
  const ammoLabel = reloading
    ? `RELOAD ${formatActiveRemainingSeconds(reloadRemainingSeconds)}`
    : `${Math.round(ammo)} / ${Math.round(maxAmmo)}`;

  return (
    <div className="hud">
      <div className="hud-row">
        <div className="hud-card">
          <p>HERO: {heroName}</p>
          <p>HP: {Math.round(hp)} / {Math.round(maxHp)}</p>
          {shield > 0 ? <p>SHIELD: {Math.round(shield)}</p> : null}
          <p>AMMO: {ammoLabel}</p>
          <p>
            SKILL: Q {formatCooldownSeconds(skillQCooldownSeconds)} · E{" "}
            {formatCooldownSeconds(skillECooldownSeconds)} · R{" "}
            {formatCooldownSeconds(skillRCooldownSeconds)}
          </p>
          {castingSkillLabel ? (
            <p>CAST: {castingSkillLabel} {formatActiveRemainingSeconds(castRemainingSeconds)}</p>
          ) : null}
          <p>KILLS: {kills}</p>
          <p>WAVE: {wave}</p>
        </div>
        <div className="hud-card">
          <p>FPS: {fps.toFixed(1)}</p>
          <p>PING: {pingMs.toFixed(1)} ms</p>
          <p>LOSS: {packetLossPct.toFixed(1)}%</p>
          <p>DRAW: {drawCalls}</p>
          <p>NET: {reconnectState}</p>
        </div>
      </div>
    </div>
  );
}
