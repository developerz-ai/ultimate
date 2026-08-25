// The state one fan-out run carries, in its own module so `fanout.ts` and `fanout-digest.ts` can
// both name it without importing each other. Nothing here decides anything — it is the shape the
// two halves of the walk agree on.

import type { Ctx } from '@ultimat3/core';
import type { StepApi } from '@ultimat3/jobs';
import type { NotifyEvent, Recipient } from './notification';
import type { NotifyPlan } from './plan';

/** Mutated in place by every branch, so one run has one set of counters rather than a merge. */
export interface Tally {
  delivered: number;
  suppressed: number;
  skipped: number;
  replayed: number;
  digested: number;
}

export interface Walk<Params> {
  readonly plan: NotifyPlan<Params>;
  readonly event: NotifyEvent<Params>;
  readonly audience: readonly Recipient[];
  readonly ctx: Ctx;
  readonly step: StepApi;
  readonly tally: Tally;
}

/** A computed `tally[flag ? 'a' : 'b']` is a dynamic property write on a shipped object, which is
 * the shape `bun run proto-index` exists to keep out of this tree. Two named fields instead. */
export const countSend = (tally: Tally, sent: boolean): void => {
  if (sent) tally.delivered += 1;
  else tally.replayed += 1;
};
