/**
 * `hive()` — one action fanned out over many inputs, declared as an `action`.
 *
 * The fourth instance of the framework's factory rule, after `llm()`, `backfill()` and `agent()`:
 * a fan-out is still one server-authoritative operation with an input schema, an output schema and
 * a policy, so this returns an `action` and inherits `.tool()`, `.openapi()`, `.client()`,
 * `.job()`, `.contract()` and its manifest row without a line here.
 *
 * It exists because the alternative is a hand-rolled `Promise.all` over `agent()` calls, and that
 * loop gets four things wrong every time: it takes the actor from somewhere other than the request,
 * it reports results in completion order, it cannot tell "ran and failed" from "never ran", and it
 * has no ceiling — so the first bad split spends the whole budget in parallel.
 */

import type { Action, ActionMcp, ActionPolicy } from '@ultimat3/action';
import { action, actionName } from '@ultimat3/action';
import type { Ctx } from '@ultimat3/core';
import { throwIfAborted, withSpan } from '@ultimat3/core';
import type { AnySchema, InferInput, InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import type { BudgetLimits } from './budget';
import { BudgetLedger, currentBudget, withBudget } from './budget';
import { HiveEmptyError } from './hive-errors';
import { runPool } from './hive-pool';
import type { HiveMember, HiveMemberError, HiveOutput, HiveResult } from './hive-result';
import { hiveResultSchema } from './hive-result';
import type { LlmBudget } from './llm';

/**
 * Members in flight at once when the declaration omits one. Small and deliberately arbitrary — it
 * is a floor to start from, not a number measured off any run: the framework cannot know a
 * provider's concurrency allowance, and a default read off one benchmark would be wrong for
 * everybody else's account. Raise it in the declaration once the run demonstrably fits.
 */
const DEFAULT_CONCURRENCY = 4;

/**
 * Below this many members the split is not fanned out at all. A member carries a fixed cost — a
 * child context, a derived ledger, a whole model call's handshake — and paying it in parallel for
 * one or two items buys nothing but a second way for the run to fail.
 */
const DEFAULT_MIN_MEMBERS = 2;

export interface HiveSplitArgs<TInput extends StandardSchemaV1> {
  readonly input: InferOutput<TInput>;
  readonly ctx: Ctx;
}

export interface HiveDef<
  TInput extends StandardSchemaV1,
  MIn extends StandardSchemaV1,
  MOut extends AnySchema,
> {
  readonly input: TInput;
  /**
   * The action every member runs — an `agent()`, an `llm()`, or any action at all. Its own
   * `policy` decides every member call and its own `input:` parses every member payload, which is
   * what keeps a hive from being a second authz system.
   */
  readonly member: Action<MIn, MOut>;
  /**
   * The one declared place a run decides what the members are. Derived from `input` and `ctx` and
   * from NOTHING a model emitted — that boundary is the same one `agent()` holds, and the reason
   * both belong in the framework rather than in a loop somebody writes per feature.
   */
  split(
    args: HiveSplitArgs<TInput>,
  ): readonly InferInput<MIn>[] | Promise<readonly InferInput<MIn>[]>;
  /** Members in flight at once. */
  readonly concurrency?: number;
  /** Below this many members the split runs serially instead of fanning out. */
  readonly minMembers?: number;
  readonly onMemberError: HiveMemberError;
  /** Ceilings for the WHOLE fan-out. `tokensPerRun` is the run's, every member counted. */
  readonly budget?: LlmBudget & { readonly tokensPerRun?: number };
  readonly policy: ActionPolicy;
  readonly mcp?: ActionMcp;
}

export function hive<
  TInput extends StandardSchemaV1,
  MIn extends StandardSchemaV1,
  MOut extends AnySchema,
>(def: HiveDef<TInput, MIn, MOut>): Action<TInput, HiveOutput<MOut>> {
  // The one cast in this file, and it narrows nothing at runtime: `hiveResultSchema` builds the
  // shape `HiveResult<InferOutput<MOut>>` describes, and this restates that in the type system
  // rather than making the caller infer it back out of a nested `t.discriminatedUnion`.
  const output = hiveResultSchema(def.member.output) as HiveOutput<MOut>;
  return action<TInput, HiveOutput<MOut>>({
    input: def.input,
    output,
    policy: def.policy,
    ...(def.mcp === undefined ? {} : { mcp: def.mcp }),
    handle: (args) => run(def, args),
  });
}

async function run<
  TInput extends StandardSchemaV1,
  MIn extends StandardSchemaV1,
  MOut extends AnySchema,
>(
  def: HiveDef<TInput, MIn, MOut>,
  args: { readonly input: InferOutput<TInput>; readonly ctx: Ctx },
): Promise<HiveResult<InferOutput<MOut>>> {
  const name = actionName(def.member);
  const inputs = await def.split({ input: args.input, ctx: args.ctx });
  if (inputs.length === 0) throw new HiveEmptyError({ member: name });

  const floor = def.minMembers ?? DEFAULT_MIN_MEMBERS;
  // A split below the floor still runs every input it produced — dropping one would be silent
  // data loss — it just stops paying for a pool to do it.
  const width =
    inputs.length < floor
      ? 1
      : Math.max(1, Math.min(def.concurrency ?? DEFAULT_CONCURRENCY, inputs.length));

  return withSpan('ai.hive', async (span) => {
    span.setAttributes({
      'hive.member': name,
      'hive.members': inputs.length,
      'hive.concurrency': width,
      'hive.on_member_error': def.onMemberError,
    });
    const ledger = (currentBudget() ?? new BudgetLedger({ limits: {} })).derive(limitsOf(def));
    const result = await withBudget(ledger, () =>
      runPool<InferInput<MIn>, InferOutput<MOut>>({
        inputs,
        width,
        ctx: args.ctx,
        onMemberError: def.onMemberError,
        member: (payload) => def.member(payload),
      }),
    );
    // The caller went away DURING the fan-out. Distinct from `onMemberError: 'abort'`, which is a
    // completed run that stopped early and has a partial harvest worth returning: here there is
    // nobody left to hand it to, so unwind the way every other abort in this package does.
    throwIfAborted(args.ctx);
    const report = await ledger.report();
    const counts = tally(result);
    span.setAttributes({ ...counts, 'hive.tokens': report.requestTokens });
    return {
      members: result,
      ok: counts['hive.ok'],
      failed: counts['hive.failed'],
      skipped: counts['hive.skipped'],
      tokens: report.requestTokens,
      cost: report.cost,
    };
  });
}

function tally<O>(members: readonly HiveMember<O>[]): {
  'hive.ok': number;
  'hive.failed': number;
  'hive.skipped': number;
} {
  return {
    'hive.ok': members.filter((one) => one.status === 'ok').length,
    'hive.failed': members.filter((one) => one.status === 'failed').length,
    'hive.skipped': members.filter((one) => one.status === 'skipped').length,
  };
}

function limitsOf<
  TInput extends StandardSchemaV1,
  MIn extends StandardSchemaV1,
  MOut extends AnySchema,
>(def: HiveDef<TInput, MIn, MOut>): BudgetLimits {
  const budget = def.budget;
  return {
    ...(budget?.tokensIn === undefined ? {} : { tokensIn: budget.tokensIn }),
    ...(budget?.costPerCall === undefined ? {} : { costPerCall: budget.costPerCall }),
    // The ledger's `request` scope accumulates across every call made under it, which for a hive
    // under `withBudget` is every member's every turn.
    ...(budget?.tokensPerRun === undefined ? {} : { request: budget.tokensPerRun }),
  };
}
