// A policy is a pure function of (input, actor, ctx). Purity is what lets the same
// object be evaluated in an HTTP request, a job, a live query and an MCP tool without
// any of them re-implementing the rule — one authz system, never two.
import type { Ctx } from '@ultimat3/core';
import { assertPermission, type KnownPermission, type Permission } from './permissions';
import { type Actor, actorHas } from './roles';

export type PolicyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; readonly code: string };

export const ALLOWED: PolicyDecision = { allowed: true };

export const denied = (reason: string, code = 'X_FORBIDDEN'): PolicyDecision => ({
  allowed: false,
  reason,
  code,
});

export interface PolicyArgs<I> {
  readonly input: I;
  readonly actor: Actor | null;
  readonly ctx?: Ctx;
}

export type PolicyPredicate<I> = (args: PolicyArgs<I>) => boolean | PolicyDecision;

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

export interface Policy<I = unknown> {
  readonly kind: PolicyKind;
  /** Stable, human-readable, safe to log: shown in traces and denial reasons. */
  readonly label: string;
  readonly permissions: readonly Permission[];
  readonly children: readonly Policy<I>[];
  run(args: PolicyArgs<I>, record?: Recorder, depth?: number): PolicyDecision;
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
export const can = <I = unknown>(
  permission: KnownPermission,
  predicate?: PolicyPredicate<I>,
): Policy<I> => {
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
export const allow = <I = unknown>(label = 'allow'): Policy<I> => ({
  kind: 'allow',
  label,
  permissions: [],
  children: [],
  run(_args, recorder, depth = 0) {
    return record(recorder, this, depth, ALLOWED);
  },
});

export const deny = <I = unknown>(reason: string, code = 'X_FORBIDDEN'): Policy<I> => ({
  kind: 'deny',
  label: `deny(${reason})`,
  permissions: [],
  children: [],
  run(_args, recorder, depth = 0) {
    return record(recorder, this, depth, denied(reason, code));
  },
});

const combined = <I>(
  kind: PolicyKind,
  label: string,
  children: readonly Policy<I>[],
  decide: (args: PolicyArgs<I>, recorder: Recorder | undefined, depth: number) => PolicyDecision,
): Policy<I> => ({
  kind,
  label,
  permissions: children.flatMap((child) => child.permissions),
  children,
  run(args, recorder, depth = 0) {
    return record(recorder, this, depth, decide(args, recorder, depth + 1));
  },
});

/** First denial wins, and its reason is the reason — short-circuit, left to right. */
export const and = <I>(...policies: readonly Policy<I>[]): Policy<I> =>
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
export const or = <I>(...policies: readonly Policy<I>[]): Policy<I> =>
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

export const not = <I>(policy: Policy<I>): Policy<I> =>
  combined('not', `not(${policy.label})`, [policy], (args, recorder, depth) => {
    const decision = policy.run(args, recorder, depth);
    return decision.allowed ? denied(`not(${policy.label}) — inner clause allowed`) : ALLOWED;
  });
