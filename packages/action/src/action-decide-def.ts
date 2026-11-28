// The declaration `action()` types a handler by: `ActionDef` whose `handle` is handed
// `decide(rows)`. A pair beside `ActionDef`, never an edit of it: `ActionDef.handle` is also what
// app code CALLS on a declaration it holds, and a required `decide` there refuses a call written
// before it existed. `action()` reads these first; `ActionDef` stays assignable to them.

import type { InferInput, InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import type { ActionDef, ActionHandlerArgs, StreamActionDef } from './action';
import type { ActionDecision } from './action-decide';

export interface ActionDecideArgs<TInput extends StandardSchemaV1, TRow = unknown>
  extends ActionHandlerArgs<TInput> {
  /**
   * This action's OWN policy, asked once per row on the surface the call came in on — one
   * `policy.decision` event per row. Rows only: no parameter names another rule. Only in `handle`,
   * after the input parse and the call's own guard; `row()` never gets it. What a handler does with
   * the denied rows (skip them, abort the batch) is its own convention (`action-decide.ts`).
   * Method syntax on purpose: its bivariant parameter is what keeps a `DecidingActionDef<…, Post>`
   * assignable to the erased declaration every projection reads.
   */
  decide(rows: readonly TRow[]): ActionDecision<TRow>;
}

/** What `action({ … })` takes: `ActionDef`, its `handle` handed `decide`. */
export interface DecidingActionDef<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  TRow = unknown,
> extends Omit<ActionDef<TInput, TOutput, TRow>, 'handle'> {
  handle(
    args: ActionDecideArgs<TInput, TRow>,
  ): Promise<InferOutput<TOutput>> | InferOutput<TOutput>;
}

/** What `action({ stream, … })` takes: `StreamActionDef`, its `handle` handed `decide`. */
export interface DecidingStreamActionDef<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  TChunk extends StandardSchemaV1,
  TRow = unknown,
> extends Omit<StreamActionDef<TInput, TOutput, TChunk, TRow>, 'handle'> {
  handle(
    args: ActionDecideArgs<TInput, TRow>,
  ): AsyncGenerator<InferInput<TChunk>, InferOutput<TOutput>, undefined>;
}
