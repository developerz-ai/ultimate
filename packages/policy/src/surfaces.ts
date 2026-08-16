// Proof that one policy covers every surface. Each adapter is the same three lines:
// evaluate, map a denial to that surface's error shape, return `undefined` when
// allowed. Adding a fifth surface means adding an adapter HERE and nothing else — no
// new policy model, no second authz path, no per-surface exceptions.
//
// An adapter names its surface and does nothing else with it: the decision log is emitted
// inside `evaluate()`, so the fifth adapter inherits it instead of having to remember it.
//
// The shapes are declared structurally rather than imported: `@ultimat3/http` is a
// sibling tier, and jobs/realtime/mcp are higher tiers that import this package.

import { forbidden } from './errors';
import { codeOf, type EvaluateArgs, evaluate, type PolicyEvaluation, reasonOf } from './evaluate';
import type { Policy } from './policy';

export type Surface = 'http' | 'live' | 'job' | 'mcp';

export interface HttpDenial {
  readonly surface: 'http';
  readonly status: 403;
  /** RFC-9457 fields `@ultimat3/http` renders verbatim. */
  readonly problem: {
    readonly title: string;
    readonly status: 403;
    readonly detail: string;
    readonly code: string;
  };
}

export interface LiveDenial {
  readonly surface: 'live';
  /** WebSocket close code in the private range; the client stops resubscribing. */
  readonly close: 4403;
  readonly code: string;
  readonly reason: string;
}

export interface JobDenial {
  readonly surface: 'job';
  readonly outcome: 'failed';
  /** Authz denials are never retried: the answer will not change on attempt two. */
  readonly retryable: false;
  readonly code: string;
  readonly reason: string;
}

export interface McpDenial {
  readonly surface: 'mcp';
  readonly isError: true;
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
}

const reason = (evaluation: PolicyEvaluation): string => reasonOf(evaluation.decision) ?? 'denied';

const code = (evaluation: PolicyEvaluation): string => codeOf(evaluation.decision) ?? 'X_FORBIDDEN';

export const enforceHttp = <I, R = unknown>(
  policy: Policy<I, R>,
  args: EvaluateArgs<I, R>,
): HttpDenial | undefined => {
  const evaluation = evaluate(policy, args, { surface: 'http' });
  if (evaluation.allowed) return undefined;
  return {
    surface: 'http',
    status: 403,
    problem: {
      title: 'policy denied this actor',
      status: 403,
      detail: reason(evaluation),
      code: code(evaluation),
    },
  };
};

export const enforceLive = <I, R = unknown>(
  policy: Policy<I, R>,
  args: EvaluateArgs<I, R>,
): LiveDenial | undefined => {
  const evaluation = evaluate(policy, args, { surface: 'live' });
  if (evaluation.allowed) return undefined;
  return { surface: 'live', close: 4403, code: code(evaluation), reason: reason(evaluation) };
};

export const enforceJob = <I, R = unknown>(
  policy: Policy<I, R>,
  args: EvaluateArgs<I, R>,
): JobDenial | undefined => {
  const evaluation = evaluate(policy, args, { surface: 'job' });
  if (evaluation.allowed) return undefined;
  return {
    surface: 'job',
    outcome: 'failed',
    retryable: false,
    code: code(evaluation),
    reason: reason(evaluation),
  };
};

export const enforceMcp = <I, R = unknown>(
  policy: Policy<I, R>,
  args: EvaluateArgs<I, R>,
): McpDenial | undefined => {
  const evaluation = evaluate(policy, args, { surface: 'mcp' });
  if (evaluation.allowed) return undefined;
  return {
    surface: 'mcp',
    isError: true,
    // An MCP client is an agent: the text has to say what was denied and why.
    content: [{ type: 'text', text: `${code(evaluation)}: ${reason(evaluation)}` }],
  };
};

export type SurfaceDenial = HttpDenial | LiveDenial | JobDenial | McpDenial;

type Adapter = <I, R>(policy: Policy<I, R>, args: EvaluateArgs<I, R>) => SurfaceDenial | undefined;

const adapters: Readonly<Record<Surface, Adapter>> = {
  http: enforceHttp,
  live: enforceLive,
  job: enforceJob,
  mcp: enforceMcp,
};

/** Dispatcher for code that is generic over surfaces (the action projector). */
export const enforce = <I, R = unknown>(
  surface: Surface,
  policy: Policy<I, R>,
  args: EvaluateArgs<I, R>,
): SurfaceDenial | undefined => adapters[surface](policy, args);

/** For call sites that would rather throw than branch. Same decision, same reason. */
export const assertAllowed = <I, R = unknown>(
  policy: Policy<I, R>,
  args: EvaluateArgs<I, R>,
): PolicyEvaluation => {
  const evaluation = evaluate(policy, args);
  if (!evaluation.allowed) throw forbidden(policy.label, reason(evaluation));
  return evaluation;
};
