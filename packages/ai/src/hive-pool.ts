// The bounded, order-preserving, cancellation-linked worker pool a hive fans out through.
//
// Apart from `hive.ts` because it is a different job with a different failure mode: that file owns
// the declaration and the budget scope, this one owns "how many at once, in what order, and what
// happens to the siblings when one throws". Nothing here knows what a model is.

import type { Ctx } from '@ultimat3/core';
import { isUltimateError, withChildContext } from '@ultimat3/core';
import type { HiveMember, HiveMemberError } from './hive-result';
import { SKIPPED_ABORTED } from './hive-result';

export interface PoolInput<I, O> {
  readonly inputs: readonly I[];
  readonly width: number;
  readonly ctx: Ctx;
  readonly onMemberError: HiveMemberError;
  /** One member run. The caller supplies it already bound, so this file never sees an action. */
  member(payload: I): Promise<O>;
}

/**
 * A bounded pool of `width` workers over one shared cursor. Results land BY INDEX, so the answer is
 * in split order however the members interleave — `Promise.all` over a mapped array would give the
 * same ordering but no ceiling, and a settle-ordered push would give neither.
 *
 * The controller is linked to `ctx.signal` in both directions that matter: the caller going away
 * aborts every member, and `onMemberError: 'abort'` aborts the siblings without touching the
 * caller's own signal. Each member runs under `withChildContext({ signal })`, which carries the
 * actor forward untouched — the hive never names an identity.
 */
export async function runPool<I, O>(input: PoolInput<I, O>): Promise<readonly HiveMember<O>[]> {
  const { inputs, width, ctx } = input;
  const members = new Array<HiveMember<O>>(inputs.length);
  const controller = new AbortController();
  const relay = (): void => controller.abort();
  if (ctx.signal.aborted) controller.abort();
  ctx.signal.addEventListener('abort', relay, { once: true });

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= inputs.length) return;
      const payload = inputs[index];
      // Every index is claimed by exactly one worker and assigned exactly once, so the array has
      // no holes for a caller to trip over — `skipped` is a recorded outcome, never an absence.
      if (controller.signal.aborted || payload === undefined) {
        members[index] = { status: 'skipped', index, reason: SKIPPED_ABORTED };
        continue;
      }
      try {
        const value = await withChildContext({ signal: controller.signal }, () =>
          input.member(payload),
        );
        members[index] = { status: 'ok', index, value };
      } catch (error) {
        members[index] = { status: 'failed', index, ...failureOf(error) };
        if (input.onMemberError === 'abort') controller.abort();
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: width }, worker));
  } finally {
    ctx.signal.removeEventListener('abort', relay);
  }
  return members;
}

/**
 * What a member threw, as two data fields — never as an error's `cause:`, which is why the thrown
 * value is read structurally and never interpolated. A foreign throw gets `'unknown'` rather than
 * an invented `X_` code: a code nothing declares is a code no `x errors explain` can answer.
 */
function failureOf(error: unknown): { readonly code: string; readonly reason: string } {
  if (isUltimateError(error)) return { code: error.code, reason: error.cause };
  if (error instanceof Error && error.message !== '') {
    return { code: 'unknown', reason: error.message };
  }
  return { code: 'unknown', reason: 'the member threw a value that is not an Error' };
}
