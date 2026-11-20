// Single responsibility: the shared-port seam. Whether this process is a supervised child
// (`ULTIMATE_CHILD=i/N`), the one place Bun.serve's `reusePort` is spelled, and the split of a
// container-wide count between children. `scripts/reuse-port-seam.ts` keeps the literal here.

import { assert } from './assert';
import { renderCauseValue } from './error-render';

type ProcessEnv = Readonly<Record<string, string | undefined>>;

/** This process's place among its siblings: `index` is zero-based, `index < count`. */
export interface SupervisedChild {
  readonly index: number;
  readonly count: number;
}

/** Canonical decimals only: a leading zero, a sign or a space is not something the supervisor writes. */
const CHILD_SHAPE = /^(0|[1-9]\d*)\/([1-9]\d*)$/;

const CHILD_FIX =
  'unset ULTIMATE_CHILD   # the production supervisor sets it for each child as <index>/<count>; set ULTIMATE_PROCESSES to choose the count';

/**
 * `ULTIMATE_CHILD`, read. Unset or empty: not a child. Anything else that is not `i/N` with
 * `0 ≤ i < N` is REFUSED (`X_INVARIANT`): only the supervisor writes the name, and a child that read
 * a garbled one as "unsupervised" would bind the shared port without `reusePort` and lose it.
 */
export function supervisedChild(env: ProcessEnv): SupervisedChild | undefined {
  const raw = env['ULTIMATE_CHILD'];
  if (raw === undefined || raw === '') return undefined;
  const match = CHILD_SHAPE.exec(raw);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  assert(
    match !== null && Number.isSafeInteger(count) && index < count,
    `ULTIMATE_CHILD=${renderCauseValue(raw)} is not <index>/<count> with 0 <= index < count`,
    CHILD_FIX,
  );
  return { index, count };
}

/**
 * The option to spread into `Bun.serve`. `{ reusePort: true }` only for a supervised child on
 * Linux — Bun ignores `SO_REUSEPORT` elsewhere, so the key is ABSENT off Linux and for a lone
 * process: an unsupervised second bind must keep failing with "port in use".
 */
export function sharedPortOption(
  env: ProcessEnv,
  platform: string = process.platform,
): { readonly reusePort?: true } {
  return supervisedChild(env) !== undefined && platform === 'linux' ? { reusePort: true } : {};
}

const isCount = (value: number, floor: number): boolean =>
  Number.isSafeInteger(value) && value >= floor;

/**
 * Child `index`'s share of a container-wide `total` (pool connections, job slots): the floor of an
 * even split, the remainder to the lowest indices, never under 1 — so the shares sum to
 * `max(total, count)`. A total under the count is the caller's to refuse or clamp first.
 */
export function childShare(total: number, index: number, count: number): number {
  assert(
    isCount(total, 0) && isCount(count, 1) && isCount(index, 0) && index < count,
    `childShare(${renderCauseValue(total)}, ${renderCauseValue(index)}, ${renderCauseValue(count)}) needs whole numbers with total >= 0, count >= 1 and 0 <= index < count`,
    'pass supervisedChild(env) as index and count, and the container-wide total as a whole number',
  );
  if (total <= count) return 1;
  return Math.floor(total / count) + (index < total % count ? 1 : 0);
}
