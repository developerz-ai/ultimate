// A policy's second projection: `scope(actor) → where`, the predicate a read hands the database so
// the visible rows arrive as one page, index-served, instead of a JS filter over an over-fetch. The
// JS rule stays the authority and still runs on every row returned. This file declares the shape and
// attaches it; composing it into a read is `@ultimat3/query`'s, which may import both sides.
import type { Policy } from './policy';
import { markPreInput, preInputRun } from './pre-input-brand';
import type { Actor } from './roles';

/**
 * The comparisons a scope may hand down — the entity chain's `andWhere` operators that compare a
 * column to a value. Restated rather than imported: `@ultimat3/entity` is this package's tier, and a
 * sideways import is a boundaries error. Every member is one of entity's `OPERATORS`; the composer
 * in `@ultimat3/query` (tier 3, which sees both) is where that subset is pinned.
 */
export type ScopeOperator =
  | 'eq'
  | 'neq'
  | 'in'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'is-null'
  | 'is-not-null';

/**
 * A column of the row the policy decides about; `string` for an untyped row (`keyof unknown` is
 * `never`). `NonNullable`, because a policy's row is often `Post | null` and `keyof` of a union with
 * `null` is `never` too.
 */
export type ScopeColumn<R> = unknown extends R ? string : Extract<keyof NonNullable<R>, string>;

/** One conjunct: entity's `Predicate` (`{ column, op, value }`), typed over the policy's row. */
export interface ScopeCondition<R = unknown> {
  readonly column: ScopeColumn<R>;
  readonly op: ScopeOperator;
  /** Absent for `is-null` / `is-not-null`; an array for `in`. Always bound, never spliced. */
  readonly value?: unknown;
}

/**
 * Every condition must hold — a conjunction, because the chain's `where` is one. `[]` is "every
 * row" (an admin), which is not the same as a policy with no scope: that one hands NOTHING down and
 * its read stays the JS rule over whatever was read.
 *
 * AND-only, decided (2026-11): no `{ or: [...] }` group. A scope lands as `@ultimat3/query`
 * `Builder` filters, so it reaches the live matcher's shape, every provider's `RowWindow.filters`
 * and the entity chain — four conjunctive contracts an OR would widen at once. A rule whose
 * visibility is a disjunction over a graph (a friend OR the author OR public, minus a block set)
 * stays unscoped: its read keeps the JS rule over what it reads.
 *
 * Called only for an actor the policy's own gate admitted: a caller refused before the read never
 * reaches it. Pure and synchronous, like a predicate — it runs once per read, not once per row.
 */
export type PolicyScope<R = unknown> = (actor: Actor | null) => readonly ScopeCondition<R>[];

/**
 * `policy`, deciding exactly as before, carrying `scope` beside it: one definition, two projections
 * (axiom 2). The scope must admit what the rule admits; a scope that disagrees with its rule on the
 * exercise seed is a finding, never a silent short page.
 *
 * The scope belongs to the clause it is declared on. `and`, `or` and `not` build a new policy and
 * carry no scope of a child's: a conjunction of children's scopes is not the scope of `or`, and a
 * guess there would hide rows the rule admits. Scope the outermost policy, over the whole rule.
 *
 * ```ts
 * export const seePost = scoped(postRule, (actor) =>
 *   actor === null
 *     ? [{ column: 'audience', op: 'eq', value: 'public' }]
 *     : [{ column: 'orgId', op: 'eq', value: actor.orgId }],
 * );
 * ```
 */
export const scoped = <I = unknown, R = unknown>(
  policy: Policy<I, R>,
  scope: PolicyScope<R>,
): Policy<I, R> => {
  const carrying: Policy<I, R> = {
    kind: policy.kind,
    label: policy.label,
    permissions: policy.permissions,
    children: policy.children,
    run: (args, recorder, depth) => policy.run(args, recorder, depth),
    // Checked against `R` where it is written; stored as the untyped shape `Policy` holds, which
    // a generic `R` cannot be proven to fit (`ScopeColumn<R>` is deferred until `R` is known).
    scope: scope as PolicyScope,
  };
  // The before-input gate answers for the scoped policy exactly as for the one it wraps.
  return markPreInput(carrying, (args, recorder, depth) =>
    preInputRun(policy, args, recorder, depth),
  );
};

/**
 * The where a read composes for `actor`, frozen, or `undefined` when the policy declares no scope.
 * What `@ultimat3/query` calls — never `policy.scope` directly, so the freeze cannot be skipped.
 */
export const policyScope = <I = unknown, R = unknown>(
  policy: Policy<I, R>,
  actor: Actor | null,
): readonly ScopeCondition[] | undefined => {
  if (policy.scope === undefined) return undefined;
  return Object.freeze(policy.scope(actor).map((condition) => Object.freeze({ ...condition })));
};
