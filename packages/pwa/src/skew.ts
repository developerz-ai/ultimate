/**
 * The PAGE's half of version skew: the message the generated worker posts on activation, and the
 * comparison a page makes against its own build meta. Split from `version-skew.ts` (ids, retention)
 * so the browser entry (`@ultimat3/pwa/client`) carries it with no error table and no server code.
 */

import type { APP_UPDATE_MESSAGE } from '@ultimat3/core/page';

export type SkewState = 'current' | 'stale' | 'unknown';

/** `unknown` means "no id sent" — a first load, a crawler, or a cache-busted client. */
export function detectSkew(
  clientBuildId: string | null | undefined,
  serverBuildId: string,
): SkewState {
  if (clientBuildId === null || clientBuildId === undefined || clientBuildId.trim() === '') {
    return 'unknown';
  }
  return clientBuildId === serverBuildId ? 'current' : 'stale';
}

/**
 * The client-side contract, and the whole of it: what the generated worker posts to every page it
 * controls on activation. The page compares `to` against its own `CLIENT_BUILD_META` meta (core's)
 * — `detectSkew` is that comparison — and renders its own "refresh to update" affordance.
 *
 * It declared `from`, `forced` and `deadlineAt` too, for a forced reload after a grace period that
 * NOTHING performed: `updateSignal`/`updatePolicy` computed the three and had no runtime caller,
 * and `x deploy --critical`, the flag that was to have set the reason, was removed in 4.0.0 for
 * being read by nobody. The two runtimes that hold both build ids cannot call into this package
 * anyway — `http`'s `ctx.clientBuildId` (tier 2) and `sync`'s `update-available` frame (tier 3)
 * are both BELOW `pwa`, and imports only go down. `version-skew.test.ts` holds this interface to
 * the literal the worker emits, so the two can no longer differ.
 */
export interface AppUpdateAvailable {
  readonly type: typeof APP_UPDATE_MESSAGE;
  /** The build the worker that posted this was generated for. */
  readonly to: string;
}
