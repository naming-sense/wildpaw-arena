import { useUiStore } from "../store/useUiStore";

export function Hud(): JSX.Element {
  const {
    hp,
    maxHp,
    kills,
    wave,
    fps,
    pingMs,
    packetLossPct,
    reconnectState,
    drawCalls,
  } = useUiStore();

  return (
    <div className="hud">
      <div className="hud-row">
        <div className="hud-card">
          <p>HP: {Math.round(hp)} / {Math.round(maxHp)}</p>
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
