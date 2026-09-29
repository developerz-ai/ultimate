// What each built policy can decide BEFORE its input is parsed, stored beside the policy rather
// than on it. A WeakMap keyed by the objects `policy.ts` builds, so a foreign `Policy` — one an
// app assembled by hand, with a `run` this package never saw — has no entry and is answered
// "depends on input": the before-input gate can only ever DEFER to the full evaluation for it,
// never decide on its behalf.
import type { Ctx } from '@ultimat3/core';
import type { PolicyDecision, Recorder } from './policy';
import type { Actor } from './roles';

/** Everything a decision before the input parse may read: who is asking, and nothing they sent. */
export interface PreInputArgs {
  readonly actor: Actor | null;
  readonly ctx?: Ctx | undefined;
}

/**
 * `undefined` is "this clause cannot be decided without the input" — a predicate would have to
 * run. A decision is final: the full evaluation of the same clause over ANY input reaches the
 * same `allowed`.
 */
export type PreInputRun = (
  args: PreInputArgs,
  recorder: Recorder | undefined,
  depth: number,
) => PolicyDecision | undefined;

const PRE_INPUT = new WeakMap<object, PreInputRun>();

/** Called once per policy `policy.ts` builds. Never exported from `src/index.ts`. */
export const markPreInput = <P extends object>(policy: P, run: PreInputRun): P => {
  PRE_INPUT.set(policy, run);
  return policy;
};

/** The before-input decision of one clause; unbranded clauses depend on input by definition. */
export const preInputRun = (
  policy: object,
  args: PreInputArgs,
  recorder: Recorder | undefined,
  depth: number,
): PolicyDecision | undefined => PRE_INPUT.get(policy)?.(args, recorder, depth);
