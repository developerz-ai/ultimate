// Pull-to-refresh as numbers and states: one resistance curve, a threshold that arms the release,
// and a refresh that runs once however many pulls arrive while it does. No DOM and no clock, so
// the component only forwards touches and the tests drive the same machine.

/** The pulled distance, in px after resistance, at which a release refreshes. */
export const PULL_THRESHOLD = 64;
/** The distance the curve approaches and never reaches: the indicator's travel. */
export const PULL_MAX = 112;

/** The one curve: 1:1 at first, flattening towards `PULL_MAX`, so a long pull feels elastic. */
export function pullDistance(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  return PULL_MAX * (1 - Math.exp(-raw / PULL_MAX));
}

export type PullState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pulling'; readonly distance: number; readonly armed: boolean }
  | { readonly kind: 'refreshing' };

export type PullEvent =
  /** A touch went down: only at the very top of the scroll, only a finger. */
  | { readonly type: 'start'; readonly atTop: boolean; readonly touch: boolean }
  /** The finger is `dy` px below where it went down. */
  | { readonly type: 'move'; readonly dy: number }
  | { readonly type: 'end' }
  /** `onRefresh` settled, resolved or rejected alike. */
  | { readonly type: 'settled' };

export const PULL_IDLE: PullState = { kind: 'idle' };

export function pullStep(state: PullState, event: PullEvent): PullState {
  switch (event.type) {
    case 'start':
      // A second pull during a refresh does nothing; a pull mid-list is the page's scroll.
      if (state.kind === 'refreshing' || !event.atTop || !event.touch) return state;
      return { kind: 'pulling', distance: 0, armed: false };
    case 'move': {
      if (state.kind !== 'pulling') return state;
      const distance = pullDistance(event.dy);
      return { kind: 'pulling', distance, armed: distance >= PULL_THRESHOLD };
    }
    case 'end':
      if (state.kind !== 'pulling') return state;
      return state.armed ? { kind: 'refreshing' } : PULL_IDLE;
    case 'settled':
      return state.kind === 'refreshing' ? PULL_IDLE : state;
  }
}

export interface PullController {
  readonly state: () => PullState;
  readonly send: (event: PullEvent) => void;
}

/**
 * The machine with its one side effect: entering `refreshing` calls `onRefresh` once, and its
 * settling — a rejection included — returns to idle. A rejection is re-thrown to `onError`, never
 * swallowed: the caller's toolbar button and its error state are where a failed refresh shows.
 */
export function pullController(
  onRefresh: () => Promise<void>,
  onChange: (state: PullState) => void,
  onError: (error: unknown) => void,
): PullController {
  let state: PullState = PULL_IDLE;
  const set = (next: PullState): void => {
    if (Object.is(next, state)) return;
    state = next;
    onChange(state);
  };
  const send = (event: PullEvent): void => {
    const before = state;
    set(pullStep(state, event));
    if (before.kind === 'refreshing' || state.kind !== 'refreshing') return;
    onRefresh().then(
      () => set(pullStep(state, { type: 'settled' })),
      (error: unknown) => {
        set(pullStep(state, { type: 'settled' }));
        onError(error);
      },
    );
  };
  return { state: () => state, send };
}
