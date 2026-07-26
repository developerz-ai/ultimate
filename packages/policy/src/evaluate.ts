// One entry point for evaluating a policy, and the only place a decision trace is
// built. The trace is what makes an authz denial debuggable: `/_x` renders it, policy
// tests assert on it, and an agent reading a 403 can see which clause decided.
import type { Ctx } from '@ultimat3/core';
import type { Policy, PolicyDecision, TraceEntry } from './policy';
import type { Actor } from './roles';

export interface EvaluateArgs<I> {
  readonly input: I;
  readonly actor: Actor | null;
  readonly ctx?: Ctx;
}

export interface PolicyEvaluation {
  readonly allowed: boolean;
  readonly decision: PolicyDecision;
  /** Depth-first, in evaluation order. Empty only for a policy that never ran. */
  readonly trace: readonly TraceEntry[];
  /** The clause whose result the caller is looking at. */
  readonly deciding: TraceEntry | null;
  readonly label: string;
}

export const evaluate = <I>(policy: Policy<I>, args: EvaluateArgs<I>): PolicyEvaluation => {
  const trace: TraceEntry[] = [];
  const decision = policy.run(
    {
      input: args.input,
      actor: args.actor,
      ...(args.ctx === undefined ? {} : { ctx: args.ctx }),
    },
    (entry) => trace.push(entry),
  );
  // Entries are recorded post-order (children before their combinator), so the first
  // entry that agrees with the outcome is the leaf that actually decided — and when a
  // reason is available it is matched too, which disambiguates `or(...)`.
  const agrees = (entry: TraceEntry): boolean => entry.allowed === decision.allowed;
  const deciding =
    trace.find(
      (entry) => agrees(entry) && (decision.allowed || entry.reason === decision.reason),
    ) ??
    trace.find(agrees) ??
    null;
  return {
    allowed: decision.allowed,
    decision,
    trace,
    deciding,
    label: policy.label,
  };
};

export const reasonOf = (decision: PolicyDecision): string | null =>
  decision.allowed ? null : decision.reason;

export const codeOf = (decision: PolicyDecision): string | null =>
  decision.allowed ? null : decision.code;

/** `post:publish -> denied: actor lacks post:publish` — one line, safe to log. */
export const explain = (evaluation: PolicyEvaluation): string => {
  const outcome = evaluation.allowed ? 'allowed' : `denied: ${reasonOf(evaluation.decision)}`;
  const by = evaluation.deciding === null ? '' : ` (by ${evaluation.deciding.label})`;
  return `${evaluation.label} -> ${outcome}${by}`;
};

/** Indented tree for the dev dashboard; one line per clause. */
export const renderTrace = (evaluation: PolicyEvaluation): string =>
  evaluation.trace
    .map((entry) => {
      const mark = entry.allowed ? 'allow' : 'deny ';
      const why = entry.reason === null ? '' : ` — ${entry.reason}`;
      return `${'  '.repeat(entry.depth)}${mark} ${entry.label}${why}`;
    })
    .join('\n');
