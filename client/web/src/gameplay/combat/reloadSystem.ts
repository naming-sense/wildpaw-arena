export interface ReloadState {
  ammo: number;
  maxAmmo: number;
  reloading: boolean;
  reloadRemainingTicks: number;
}

export function startReload(state: ReloadState, reloadTicks: number): ReloadState {
  if (state.reloading) return state;

  return {
    ...state,
    reloading: true,
    reloadRemainingTicks: Math.max(0, Math.floor(reloadTicks)),
  };
}

export function tickReload(state: ReloadState, elapsedTicks: number): ReloadState {
  if (!state.reloading) return state;

  const remaining = Math.max(0, state.reloadRemainingTicks - Math.max(0, Math.floor(elapsedTicks)));
  if (remaining > 0) {
    return {
      ...state,
      reloadRemainingTicks: remaining,
    };
  }

  return {
    ...state,
    ammo: state.maxAmmo,
    reloading: false,
    reloadRemainingTicks: 0,
  };
}

export function consumeAmmo(state: ReloadState, amount = 1): ReloadState {
  return {
    ...state,
    ammo: Math.max(0, state.ammo - Math.max(0, Math.floor(amount))),
  };
}
