// The ratchet for `scripts/index-of-order.ts`: how many ordering assertions a package may still
// build on an `indexOf` whose needle nothing asserts present. A count may only SHRINK — a lowered
// one is `X_INDEX_ORDER_PIN_STALE`, so the repair and the pin land in one commit.
//
// Each entry says what the remaining sites are and why they have not been repaired yet. "There
// was a reason" is not one; a blank reason is the documentation axiom 3 says does not exist.

export interface OrderPin {
  readonly pkg: string;
  readonly count: number;
  readonly reason: string;
}

export const INDEX_OF_ORDER_PINS: readonly OrderPin[] = [];
