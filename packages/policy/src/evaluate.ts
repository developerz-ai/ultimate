// One entry point for evaluating a policy, and the only place a decision trace is
// built. The trace is what makes an authz denial debuggable: `/_x` renders it, policy
// tests assert on it, and an agent reading a 403 can see which clause decided.
// It is also the one place a decision reaches the `DecisionSink` — allowed decisions
// included, since "who was let in" is the half an audit actually needs.
import { type Ctx, DEFAULT_ENVIRONMENT, tryResolveEnvironment } from '@ultimat3/core';
import { decisionSinkInstalled, emitDecision } from './decisions';
import type { Policy, PolicyDecision, TraceEntry } from './policy';
import type { Actor } from './roles';
import type { Surface } from './surfaces';

/**
 * What a *caller* supplies. `row` is optional here and required in `PolicyArgs`: a surface
 * that decides on input alone should not have to write `row: null`, but the predicate it
 * reaches must still see the field. `evaluate()` is the one place that gap is closed.
 */
export interface EvaluateArgs<I, R = unknown> {
  readonly input: I;
  readonly actor: Actor | null;
  /** The already-loaded row for a row-level rule. Omitted means "this rule has no row". */
  readonly row?: R;
  readonly ctx?: Ctx;
}

export interface EvaluateOptions {
  /**
   * Build the trace. Defaults to on outside production, and to on in production only once a
   * `DecisionSink` is installed — a `TraceEntry[]` per evaluation is real allocation on the
   * live-query path, where one write fans out to one evaluation per subscriber.
   */
  readonly trace?: boolean | undefined;
  /** Which adapter asked. Carried to the sink; the decision itself never depends on it. */
  readonly surface?: Surface | undefined;
}

export interface PolicyEvaluation {
  readonly allowed: boolean;
  readonly decision: PolicyDecision;
  /** Depth-first, in evaluation order. Empty for a policy that never ran, or a trace turned off. */
  readonly trace: readonly TraceEntry[];
  /** The clause whose result the caller is looking at. `null` when the trace is off. */
  readonly deciding: TraceEntry | null;
  readonly label: string;
}

let outsideProduction: boolean | undefined;

/**
 * Resolved once and cached: `ULTIMATE_ENV` cannot change under a running process, and reading
 * `process.env` per evaluation is exactly the per-subscriber cost this change exists to remove.
 * Non-throwing on purpose — a malformed `ULTIMATE_ENV` is its own error with its own fix, and it
 * must never be raised for the first time by an authz check.
 */
const traceByDefault = (): boolean => {
  outsideProduction ??= (tryResolveEnvironment() ?? DEFAULT_ENVIRONMENT) !== 'production';
  return outsideProduction || decisionSinkInstalled();
};

/** Test seam: re-reads the environment on the next evaluation. */
export const resetPolicyTracing = (): void => {
  outsideProduction = undefined;
};

export const evaluate = <I, R = unknown>(
  policy: Policy<I, R>,
  args: EvaluateArgs<I, R>,
  options?: EvaluateOptions,
): PolicyEvaluation => {
  const trace: TraceEntry[] = [];
  const wanted = options?.trace ?? traceByDefault();
  const decision = policy.run(
    {
      input: args.input,
      actor: args.actor,
      // Normalising here is what keeps `row` a required field of `PolicyArgs`: an absent row
      // and an explicit `null` reach the predicate as the same value, so no rule needs to
      // handle both.
      row: args.row ?? null,
      ...(args.ctx === undefined ? {} : { ctx: args.ctx }),
    },
    // No recorder at all when the trace is off, so not even the closure is allocated.
    wanted ? (entry) => trace.push(entry) : undefined,
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
  if (decisionSinkInstalled()) {
    emitDecision({
      label: policy.label,
      allowed: decision.allowed,
      code: decision.allowed ? null : decision.code,
      reason: decision.allowed ? null : decision.reason,
      actorId: args.actor?.id ?? null,
      actorKind: args.actor?.kind ?? null,
      orgId: args.actor?.orgId ?? null,
      surface: options?.surface ?? null,
      deciding: deciding?.label ?? null,
    });
  }
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
