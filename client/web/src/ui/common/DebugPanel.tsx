import { useUiStore } from "../store/useUiStore";

export function DebugPanel(): JSX.Element | null {
  const state = useUiStore();
  if (!state.showDebug) return null;

  return (
    <div className="debug-panel">
      <div>Frame: {state.frameMs.toFixed(2)}ms</div>
      <div>Jitter: {state.jitterMs.toFixed(2)}ms</div>
      <div>Reconnect State: {state.reconnectState}</div>
      <button type="button" onClick={state.toggleDebug}>
        디버그 숨기기
      </button>
    </div>
  );
}
