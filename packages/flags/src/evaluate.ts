// Single responsibility: `isEnabled()` — the one way to ask a flag a question. Synchronous, for
// the same reason `can()` is: this runs inside policy predicates and render passes, and an `await`
// there turns every guarded branch into an async boundary.

import type { Actor } from '@ultimat3/core';
import { flagExpired } from './errors';
import type { Flag } from './flag';
import { flagFor } from './registry';
import { flagsClock, reportOnce } from './runtime';
import { evaluateTargeting } from './targeting';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The lifecycle rule, enforced on the one path nobody can avoid. An overdue temporary flag reports
 * itself where it is USED, not where it is declared — a declaration is read once at boot and can
 * sit in a module nothing evaluates, while an evaluation proves the branch is still live.
 *
 * It reports and returns; it never throws. An expiry is a debt, not an outage, and a framework
 * that took production down on a date nobody remembered setting would teach everyone to declare
 * every flag `permanent`, which is the failure this design exists to prevent.
 */
function reportIfOverdue(flag: Flag): void {
  if (flag.expiresAtMs === null || flag.owner === null || flag.expiresAt === null) return;
  const nowMs = flagsClock().now().getTime();
  if (nowMs < flag.expiresAtMs) return;
  const expiresAt = flag.expiresAt;
  const owner = flag.owner;
  const overdueDays = Math.floor((nowMs - flag.expiresAtMs) / MS_PER_DAY);
  reportOnce(flag.key, () => flagExpired({ key: flag.key, owner, expiresAt, overdueDays }));
}

/**
 * Is `key` on for `actor`? An undeclared key throws `X_FLAG_UNKNOWN` rather than answering `false`
 * — see `flagFor`.
 *
 * `actor` is passed rather than read from the ambient context on purpose: a policy predicate,
 * a job and a render pass each already hold the actor they are deciding about, and reading an
 * ambient one would let a job evaluate a flag for whoever enqueued it.
 */
export function isEnabled(key: string, actor: Actor | null): boolean {
  const flag = flagFor(key);
  reportIfOverdue(flag);
  return evaluateTargeting(flag.key, flag.targeting, actor);
}
