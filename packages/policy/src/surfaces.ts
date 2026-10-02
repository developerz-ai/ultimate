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

import { describeErrorCode } from '@ultimat3/core';
import { denialError, surfaceUnknown } from './errors';
import { codeOf, type EvaluateArgs, evaluate, type PolicyEvaluation, reasonOf } from './evaluate';
import type { Policy } from './policy';

export type Surface = 'http' | 'live' | 'job' | 'mcp';

/** 401 when the decision says nobody is signed in, 403 for every other denial. */
export type DenialStatus = 401 | 403;

export interface HttpDenial {
  readonly surface: 'http';
  readonly status: DenialStatus;
  /** RFC-9457 fields `@ultimat3/http` renders verbatim. */
  readonly problem: {
    readonly title: string;
    readonly status: DenialStatus;
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

/**
 * The status a denial's code means. Only `X_UNAUTHENTICATED` is "come back signed in"; every other
 * code — `X_FORBIDDEN`, or one an app's predicate chose — is a refusal of this actor. It was a
 * pinned `403` beside a problem whose own `code` said `X_UNAUTHENTICATED`.
 */
const statusOf = (denialCode: string): DenialStatus =>
  denialCode === 'X_UNAUTHENTICATED' ? 401 : 403;

export const enforceHttp = <I, R = unknown>(
  policy: Policy<I, R>,
  args: EvaluateArgs<I, R>,
): HttpDenial | undefined => {
  const evaluation = evaluate(policy, args, { surface: 'http' });
  if (evaluation.allowed) return undefined;
  const denialCode = code(evaluation);
  const status = statusOf(denialCode);
  return {
    surface: 'http',
    status,
    problem: {
      // The CODE's registered title, so the document reads as one fact: the owner of the code
      // wrote it once, and `X_FORBIDDEN`'s own title is this package's.
      title: describeErrorCode(denialCode).title,
      status,
      detail: reason(evaluation),
      code: denialCode,
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

/** The surfaces that have an adapter, derived from the table so the two cannot disagree. */
const SURFACES: readonly string[] = Object.keys(adapters);

/**
 * Dispatcher for code that is generic over surfaces (the action projector).
 *
 * `Object.hasOwn` and not a truthiness check on `adapters[surface]`: the table is an object
 * literal, so it inherits `Object.prototype`, and `enforce('valueOf' as Surface, …)` called
 * `Object.prototype.valueOf` with `adapters` as its receiver — a truthy return, so the call failed
 * CLOSED, and the adapter table typed as a `SurfaceDenial`, so nothing downstream could say what
 * was denied. Every in-repo caller passes a literal; a config-driven table, a surface name off the
 * wire or a JS host does not, and this is a public authz entry point.
 */
export const enforce = <I, R = unknown>(
  surface: Surface,
  policy: Policy<I, R>,
  args: EvaluateArgs<I, R>,
): SurfaceDenial | undefined => {
  if (!Object.hasOwn(adapters, surface)) throw surfaceUnknown(surface, SURFACES);
  return adapters[surface](policy, args);
};

/** For call sites that would rather throw than branch. Same decision, same reason, same CODE. */
export const assertAllowed = <I, R = unknown>(
  policy: Policy<I, R>,
  args: EvaluateArgs<I, R>,
): PolicyEvaluation => {
  const evaluation = evaluate(policy, args);
  if (!evaluation.allowed) throw denialError(policy.label, reason(evaluation), code(evaluation));
  return evaluation;
};
