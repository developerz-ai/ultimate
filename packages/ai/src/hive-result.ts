// What a hive run answers, as a TYPE and as a SCHEMA built from the member's own `output`.
//
// It is a schema and not a plain interface because `hive()` returns an `action`, and an action's
// `output:` is what drives `validateOutput`, the OpenAPI response body, the typed client, the MCP
// tool and the manifest row. A hand-written interface would give the type and none of the six
// projections — the whole reason a hive is a factory over `action()` rather than a helper.

import type { Money } from '@ultimat3/money';
import type { AnySchema, InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import { t } from '@ultimat3/schema';

/**
 * One member's outcome. THREE arms, not two: a member that ran and threw and a member that never
 * ran at all are different facts, and the second one is what an aborted sibling is. Collapsing
 * them would make "the hive stopped early" indistinguishable from "every remaining item is bad
 * data", which is the difference between retrying the tail and fixing the source.
 *
 * `index` is the position in `split`'s output on every arm, so a caller can join a result back to
 * the row it came from without depending on array position surviving a filter.
 */
export type HiveMember<O> =
  | { readonly status: 'ok'; readonly index: number; readonly value: O }
  | {
      readonly status: 'failed';
      readonly index: number;
      /** The `UltimateError` code the member threw, or `'unknown'` for a foreign throw. */
      readonly code: string;
      readonly reason: string;
    }
  | { readonly status: 'skipped'; readonly index: number; readonly reason: string };

export interface HiveResult<O> {
  /** In SPLIT order, always — never completion order, and never with the failures filtered out. */
  readonly members: readonly HiveMember<O>[];
  readonly ok: number;
  readonly failed: number;
  /**
   * Published beside `ok` and `failed` rather than left to be derived: three arms and two counters
   * means `members.length - ok - failed`, and a caller who writes that once writes it wrong once.
   */
  readonly skipped: number;
  /** Tokens the whole run debited, every member counted, from the hive's own derived ledger. */
  readonly tokens: number;
  readonly cost: Money;
}

/** The declared shape of `hive()`'s output, given the member action's own `output`. */
export type HiveOutput<MOut extends AnySchema> = StandardSchemaV1<
  unknown,
  HiveResult<InferOutput<MOut>>
>;

/** What a member failure means for its siblings. No default: both answers are somebody's bug. */
export type HiveMemberError =
  /** Stop. Siblings that have not started are `skipped`; ones in flight see the aborted signal. */
  | 'abort'
  /** Record it as `failed` and keep going — a partial harvest is the point of a hive. */
  | 'collect';

export const SKIPPED_ABORTED = 'a sibling failed and onMemberError is abort';

/**
 * The OTHER way a member never runs, and a different fact: `split` produced nothing at this
 * index. Its own string because `SKIPPED_ABORTED` named a cause that did not happen — a caller
 * reading it retries the tail against a hive that stopped early, when the split is what to fix.
 */
export const SKIPPED_NO_INPUT = 'split produced no input at this index';

/**
 * The member's `output` embedded verbatim in the `ok` arm, so a hive over `summarisePost` publishes
 * a summary in its OpenAPI response and its MCP `outputSchema` — not an opaque object.
 *
 * A DISCRIMINATED union, not a plain one: `status` routes the parse, so a malformed `ok` reports
 * that arm's issues instead of all three arms' at once.
 */
export function hiveResultSchema(output: AnySchema): AnySchema {
  const member = t.discriminatedUnion(
    'status',
    t.object({ status: t.literal('ok'), index: t.number.int(), value: output }),
    t.object({
      status: t.literal('failed'),
      index: t.number.int(),
      code: t.string,
      reason: t.string,
    }),
    t.object({ status: t.literal('skipped'), index: t.number.int(), reason: t.string }),
  );
  return t.object({
    members: t.array(member),
    ok: t.number.int(),
    failed: t.number.int(),
    skipped: t.number.int(),
    tokens: t.number.int(),
    cost: t.money,
  });
}
