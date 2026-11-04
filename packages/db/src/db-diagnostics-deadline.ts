// Single responsibility: stop WAITING for a diagnostic read the server never answers. PGlite applies
// `statement_timeout` and cannot fire it mid-scan, so on the embedded database the 2 s bound is no
// bound; this one is the client's, and it abandons the wait, not the statement.

import type { Scheduler } from '@ultimat3/core';

/** What `within` answers when the deadline came first. */
export const EXPIRED: unique symbol = Symbol('diagnostics.expired');

/**
 * `work`'s answer, or `EXPIRED` once `ms` pass. A rejection arriving after the deadline is
 * handled here, never left unhandled; the statement itself runs on until its driver ends it.
 */
export async function within<T>(
  work: Promise<T>,
  ms: number,
  schedule: Scheduler,
): Promise<T | typeof EXPIRED> {
  let cancel: () => void = () => undefined;
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    cancel = schedule(() => resolve(EXPIRED), ms);
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, expired]);
  } finally {
    cancel();
  }
}

/** A deadline that, once passed, stays passed: the whole command's budget. */
export interface CommandDeadline {
  passed(): boolean;
  release(): void;
}

export function commandDeadline(ms: number, schedule: Scheduler): CommandDeadline {
  let passed = false;
  const cancel = schedule(() => {
    passed = true;
  }, ms);
  return { passed: () => passed, release: cancel };
}
