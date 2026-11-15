// Single responsibility: the replicator's change handler as a PASS on a heartbeat the host hands
// in. The host's liveness (`packages/cli/src/runtime-liveness.ts`) judges a pass held open too long
// — a publish that never returns — as a wedged replicator. Structural, so this package names no
// jobs type: `@ultimat3/jobs`' `loopHeartbeat()` is what the cli passes.

import type { ChangeEvent } from './changefeed';

/** A pass begins; the answer ends it, idempotently. */
export interface PassHeartbeat {
  enter(): () => void;
}

/** `handler`, each call held open on `heartbeat` until it settles. No heartbeat: `handler` itself. */
export function heldBy(
  heartbeat: PassHeartbeat | undefined,
  handler: (change: ChangeEvent) => Promise<void>,
): (change: ChangeEvent) => Promise<void> {
  if (heartbeat === undefined) return handler;
  return async (change) => {
    const leave = heartbeat.enter();
    try {
      await handler(change);
    } finally {
      leave();
    }
  };
}
