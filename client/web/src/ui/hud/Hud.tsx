import { useUiStore } from "../store/useUiStore";

export function Hud(): JSX.Element {
  const {
    hp,
    maxHp,
    heroName,
    ammo,
    maxAmmo,
    reloading,
    kills,
    wave,
    fps,
    pingMs,
    packetLossPct,
    reconnectState,
    drawCalls,
    renderDpr,
    fowMode,
    buildTag,
  } = useUiStore();

  return (
    <div className="hud">
      <div className="hud-row">
        <div className="hud-card">
          <p>HERO: {heroName}</p>
          <p>HP: {Math.round(hp)} / {Math.round(maxHp)}</p>
          <p>AMMO: {reloading ? "RELOAD" : `${Math.round(ammo)} / ${Math.round(maxAmmo)}`}</p>
          <p>KILLS: {kills}</p>
          <p>WAVE: {wave}</p>
        </div>
        <div className="hud-card">
          <p>FPS: {fps.toFixed(1)}</p>
          <p>PING: {pingMs.toFixed(1)} ms</p>
          <p>LOSS: {packetLossPct.toFixed(1)}%</p>
          <p>DRAW: {drawCalls}</p>
          <p>DPR: {renderDpr.toFixed(2)}</p>
          <p>FOW: {fowMode}</p>
          <p>VER: {buildTag}</p>
          <p>NET: {reconnectState}</p>
        </div>
      </div>
    </div>
  );
}
