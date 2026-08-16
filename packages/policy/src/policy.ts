// A policy is a pure function of (input, actor, row, ctx). Purity is what lets the same
// object be evaluated in an HTTP request, a job, a live query and an MCP tool without
// any of them re-implementing the rule — one authz system, never two.
import type { Ctx } from '@ultimat3/core';
import { actorHas } from './grant-index';
import { assertPermission, type KnownPermission, type Permission } from './permissions';
import type { Actor } from './roles';

export type PolicyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; readonly code: string };

export const ALLOWED: PolicyDecision = { allowed: true };

export const denied = (reason: string, code = 'X_FORBIDDEN'): PolicyDecision => ({
  allowed: false,
  reason,
  code,
});

/**
 * The one shape every predicate sees, on every surface. An input-level rule reads `input`,
 * a row-level rule reads `row`, and neither has to know which surface called it.
 */
export interface PolicyArgs<I = unknown, R = unknown> {
  readonly input: I;
  readonly actor: Actor | null;
  /**
   * The already-loaded row a row-level rule decides about; `null` when the rule decides on
   * input alone.
   *
   * Required and nullable rather than optional, deliberately. An optional `row?: R` lets the
   * two shapes drift apart again: a surface that forgets to pass it still typechecks, so a
   * row rule reading `args.row` silently sees `undefined` and denies (or worse, allows) for
   * the wrong reason. `R | null` forces every caller to say which case it is, and makes
   * "no row here" a value the predicate can branch on instead of an absence it must guess at.
   * This is the field that used to be smuggled inside `input` by the realtime row gate.
   */
  readonly row: R | null;
  readonly ctx?: Ctx;
}

export type PolicyPredicate<I, R = unknown> = (args: PolicyArgs<I, R>) => boolean | PolicyDecision;

export type PolicyKind = 'permission' | 'allow' | 'deny' | 'and' | 'or' | 'not';

export interface TraceEntry {
  readonly label: string;
  readonly kind: PolicyKind;
  readonly depth: number;
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly code: string | null;
}

export type Recorder = (entry: TraceEntry) => void;

/** `R` is defaulted so `Policy<Input>` keeps meaning "decides on input, any row or none". */
export interface Policy<I = unknown, R = unknown> {
  readonly kind: PolicyKind;
  /** Stable, human-readable, safe to log: shown in traces and denial reasons. */
  readonly label: string;
  readonly permissions: readonly Permission[];
  readonly children: readonly Policy<I, R>[];
  run(args: PolicyArgs<I, R>, record?: Recorder, depth?: number): PolicyDecision;
}

const record = (
  recorder: Recorder | undefined,
  policy: { kind: PolicyKind; label: string },
  depth: number,
  decision: PolicyDecision,
): PolicyDecision => {
  recorder?.({
    label: policy.label,
    kind: policy.kind,
    depth,
    allowed: decision.allowed,
    reason: decision.allowed ? null : decision.reason,
    code: decision.allowed ? null : decision.code,
  });
  return decision;
};

const asDecision = (result: boolean | PolicyDecision, label: string): PolicyDecision => {
  if (typeof result === 'boolean') {
    return result ? ALLOWED : denied(`${label} predicate returned false`);
  }
  return result;
};

/**
 * The blessed constructor. The permission is checked first and the optional
 * predicate second, so a denial reason distinguishes "you may never do this" from
 * "you may, but not to this row" — an agent can act on the difference.
 */
export const can = <I = unknown, R = unknown>(
  permission: KnownPermission,
  predicate?: PolicyPredicate<I, R>,
): Policy<I, R> => {
  assertPermission(permission);
  const label = permission;
  return {
    kind: 'permission',
    label,
    permissions: [permission as Permission],
    children: [],
    run(args, recorder, depth = 0) {
      if (args.actor === null) {
        return record(recorder, this, depth, denied(`no actor for ${label}`, 'X_UNAUTHENTICATED'));
      }
      if (!actorHas(args.actor, permission as Permission)) {
        return record(recorder, this, depth, denied(`actor lacks ${label}`));
      }
      if (predicate === undefined) return record(recorder, this, depth, ALLOWED);
      return record(recorder, this, depth, asDecision(predicate(args), label));
    },
  };
};

/** Explicitly public. Saying so is required; forgetting a policy is a build error. */
export const allow = <I = unknown, R = unknown>(label = 'allow'): Policy<I, R> => ({
  kind: 'allow',
  label,
  permissions: [],
  children: [],
  run(_args, recorder, depth = 0) {
    return record(recorder, this, depth, ALLOWED);
  },
});

export const deny = <I = unknown, R = unknown>(
  reason: string,
  code = 'X_FORBIDDEN',
): Policy<I, R> => ({
  kind: 'deny',
  label: `deny(${reason})`,
  permissions: [],
  children: [],
  run(_args, recorder, depth = 0) {
    return record(recorder, this, depth, denied(reason, code));
  },
});

/**
 * Every permission a policy tree references, deduped and sorted. This is the list a compliance
 * report has to read: `label` renders a composite as `and(post:publish, org:administer)`, which
 * is a sentence, not a permission — matching a grant against it reports every non-trivial rule's
 * permissions as unenforced.
 *
 * A `not()` clause contributes its inner permissions too. The grant still decides the outcome,
 * so "nothing references this permission" would be the false statement, not this one.
 */
export const policyPermissions = <I = unknown, R = unknown>(
  policy: Policy<I, R>,
): readonly Permission[] => policy.permissions;

const flatten = (children: readonly { readonly permissions: readonly Permission[] }[]) =>
  [...new Set(children.flatMap((child) => child.permissions))].sort();

// Combinators hand `args` to every child untouched — `row` included. A clause that rewrote
// the args would be the second authz shape all over again.
const combined = <I, R>(
  kind: PolicyKind,
  label: string,
  children: readonly Policy<I, R>[],
  decide: (args: PolicyArgs<I, R>, recorder: Recorder | undefined, depth: number) => PolicyDecision,
): Policy<I, R> => ({
  kind,
  label,
  permissions: flatten(children),
  children,
  run(args, recorder, depth = 0) {
    return record(recorder, this, depth, decide(args, recorder, depth + 1));
  },
});

/** First denial wins, and its reason is the reason — short-circuit, left to right. */
export const and = <I, R = unknown>(...policies: readonly Policy<I, R>[]): Policy<I, R> =>
  combined(
    'and',
    `and(${policies.map((policy) => policy.label).join(', ')})`,
    policies,
    (args, recorder, depth) => {
      for (const policy of policies) {
        const decision = policy.run(args, recorder, depth);
        if (!decision.allowed) return decision;
      }
      return ALLOWED;
    },
  );

/** First allowance wins; if none allow, the LAST denial is reported. */
export const or = <I, R = unknown>(...policies: readonly Policy<I, R>[]): Policy<I, R> =>
  combined(
    'or',
    `or(${policies.map((policy) => policy.label).join(', ')})`,
    policies,
    (args, recorder, depth) => {
      let last: PolicyDecision = denied('no clause allowed this actor');
      for (const policy of policies) {
        const decision = policy.run(args, recorder, depth);
        if (decision.allowed) return ALLOWED;
        last = decision;
      }
      return last;
    },
  );

/**
 * Inverts a decision about an actor's grants — and only that.
 *
 * `X_UNAUTHENTICATED` is propagated, never inverted. "There is no actor" is not a fact about
 * this actor's permissions, so flipping it makes `not(can('order:internal'))` read as *allow
 * everyone who is not internal, anonymous callers first*. That is how a "public unless internal"
 * route becomes a public internal route: the mistake is invisible in `and(can(…), not(can(…)))`
 * because the first clause carries the authentication, and it ships the moment someone simplifies.
 */
export const not = <I, R = unknown>(policy: Policy<I, R>): Policy<I, R> =>
  combined('not', `not(${policy.label})`, [policy], (args, recorder, depth) => {
    const decision = policy.run(args, recorder, depth);
    if (decision.allowed) return denied(`not(${policy.label}) — inner clause allowed`);
    if (decision.code === 'X_UNAUTHENTICATED') return decision;
    return ALLOWED;
  });
