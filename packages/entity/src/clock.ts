// Single responsibility: the instant the entity layer WRITES. One reader of the clock, so
// `defaultNow()`, `onUpdateNow()`, the soft-delete stamp and a seed's `now` are one value from one
// source — and a second `systemClock.now()` anywhere on the write path is a timestamp no test can
// drive and no two of these four can agree with.

import { systemClock, tryUseContext } from '@ultimat3/core';

/**
 * `ctx.clock`, and the system clock outside every request.
 *
 * The READ path reads no clock at all, which is what makes it drivable (`@ultimat3/query`'s
 * CLAUDE.md says so in as many words). The write path read `systemClock` directly at five sites, so
 * a frozen test clock drove nothing the entity layer stamped: `createdAt`, `updatedAt` and
 * `deletedAt` all came from the wall clock however the ctx was built, and a test asserting on one
 * had to assert a range instead of a value. Outside a request there is no ctx and the system clock
 * IS the answer — a script, a worker boot and a seed all take that branch, exactly as before.
 */
export const entityNow = (): Date => (tryUseContext()?.clock ?? systemClock).now();
