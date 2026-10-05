// The bounded, order-preserving, cancellation-linked worker pool a hive fans out through.
//
// Apart from `hive.ts` because it is a different job with a different failure mode: that file owns
// the declaration and the budget scope, this one owns "how many at once, in what order, and what
// happens to the siblings when one throws". Nothing here knows what a model is.

import type { Ctx } from '@ultimat3/core';
import { withChildContext } from '@ultimat3/core';
import { discloseFailure } from './failure-disclosure';
import type { HiveMember, HiveMemberError } from './hive-result';
import { SKIPPED_ABORTED, SKIPPED_NO_INPUT } from './hive-result';

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
      // Two reasons, because they are two facts: the run stopped, or the split had nothing here.
      if (controller.signal.aborted || payload === undefined) {
        const reason = controller.signal.aborted ? SKIPPED_ABORTED : SKIPPED_NO_INPUT;
        members[index] = { status: 'skipped', index, reason };
        continue;
      }
      try {
        const value = await withChildContext({ signal: controller.signal }, () =>
          input.member(payload),
        );
        members[index] = { status: 'ok', index, value };
      } catch (error) {
        members[index] = { status: 'failed', index, ...failureOf(error, ctx, index) };
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
 * What the caller may read of a member's throw, as two data fields — never as an error's `cause:`.
 * The reason ships in the hive action's 200 answer, so it is `discloseFailure`'s verdict, the one
 * the tool result gets: a 5xx cause or a foreign `.message` (a pg `Key (email)=(…)`) is withheld
 * and logged whole. A throw with no code gets `'unknown'` rather than an invented `X_` code: a code
 * nothing declares is a code no `x errors explain` can answer.
 */
function failureOf(
  error: unknown,
  ctx: Ctx,
  index: number,
): { readonly code: string; readonly reason: string } {
  // `fix` is not carried: `reason` has always been the cause alone, and a member's caller acts on
  // the code. What `discloseFailure` withholds stays withheld either way.
  const shown = discloseFailure(error, ctx.logger, `hive member ${index}`);
  return { code: shown.code ?? 'unknown', reason: shown.cause ?? HIDDEN_MEMBER_CAUSE };
}

/**
 * What a caller reads in place of a reason it may not see. Fixed, so nothing of the throw rides on
 * it — the hive's answer goes wherever its caller sends it, a model's context included.
 */
export const HIDDEN_MEMBER_CAUSE =
  'the member failed inside the server; the details are withheld from this answer; the server log records its code and where it failed';
