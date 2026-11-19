// Pure fact-gathering behind `x policy`: every declared permission projected against the roles
// that grant it and the declarations that enforce it, plus the per-role allow/deny matrix behind
// `explain`. No CLI shapes, no `msg()` — testable with real registries and no app to load.

import type { AnyAction } from '@ultimat3/action';
import { describeActions, getAction } from '@ultimat3/action';
import type { Policy } from '@ultimat3/policy';
import { knownPermissions, policyMatrix, roleDefinitions, rolesGranting } from '@ultimat3/policy';
import type { AnyQuery } from '@ultimat3/query';
import { describeQueries, getQuery } from '@ultimat3/query';
import { devActors } from './dev-policy';
import { decided, type ExplainRow, rowWithoutInput } from './policy-row';

const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

/**
 * Descriptor names whose policy references this permission — shared by list and explain.
 *
 * Matched on `permissions` and never on `capability`. `capability` is the DISPLAY label, and a
 * composite policy renders as `and(post:publish, org:administer)` — never a bare permission — so
 * an equality test against it reported every action guarded by a composite as enforcing nothing.
 * That is `unenforced`: "this grant does nothing", printed about every non-trivial rule in a real
 * app, to the compliance engineer reading it before an access review.
 */
const namesEnforcing = <
  D extends { readonly name: string; readonly permissions: readonly string[] },
>(
  descriptors: readonly D[],
  permission: string,
): readonly string[] =>
  descriptors
    .filter((descriptor) => descriptor.permissions.includes(permission))
    .map((d) => d.name);

/** The same rule as `namesEnforcing`, for the two `explain` filters that keep the descriptor. */
const enforces = (
  descriptor: { readonly permissions: readonly string[] },
  permission: string,
): boolean => descriptor.permissions.includes(permission);

// ── list ──────────────────────────────────────────────────────────────────

export interface PermissionRow {
  readonly permission: string;
  readonly roles: readonly string[];
  readonly actions: readonly string[];
  readonly queries: readonly string[];
}

export interface PolicyListFacts {
  readonly rows: readonly PermissionRow[];
  readonly roleCount: number;
  readonly enforcedCount: number;
  /** Permissions no action or query enforces — a grant that does nothing. */
  readonly unenforced: readonly string[];
}

export function listPolicy(): PolicyListFacts {
  const actionDescriptors = describeActions();
  const queryDescriptors = describeQueries();
  const rows = knownPermissions().map(
    (permission): PermissionRow => ({
      permission,
      roles: rolesGranting(permission),
      actions: namesEnforcing(actionDescriptors, permission),
      queries: namesEnforcing(queryDescriptors, permission),
    }),
  );
  const unenforced = rows
    .filter((row) => row.actions.length === 0 && row.queries.length === 0)
    .map((row) => row.permission);
  return {
    rows,
    roleCount: Object.keys(roleDefinitions()).length,
    enforcedCount: rows.length - unenforced.length,
    unenforced,
  };
}

// ── explain ───────────────────────────────────────────────────────────────

export type DeclarationKind = 'action' | 'query';
export type SubjectKind = 'permission' | DeclarationKind;

/** What `x policy explain --input '<json>'` supplies: the request's input, parsed. */
export interface ExplainOptions {
  /** Absent: no input was given, and a rule that reads one is `needs-input`. */
  readonly input?: { readonly value: unknown } | undefined;
}

export interface DeclarationExplanation {
  readonly name: string;
  readonly kind: DeclarationKind;
  /** The policy's DISPLAY label — `and(post:publish, org:administer)` for a composite. */
  readonly capability: string;
  /**
   * Every permission the policy tree references, flattened. What a grant is MATCHED against; the
   * label above is what a person reads. Published because `grantingRoles` is derived from it —
   * `rolesGranting('and(a:b, c:d)')` is a lookup that can only ever answer nothing.
   */
  readonly permissions: readonly string[];
  readonly label: string;
  /**
   * Whether this policy could be evaluated at all. `false` only when it threw on the input
   * `--input` supplied — a row rule dereferencing a row there is none of, a field the JSON did not
   * carry — and `rows` is then empty, because a partial matrix reads as a verdict. With no input
   * given a throwing predicate is a `needs-input` row instead: the missing input is why it threw.
   */
  readonly decidable: boolean;
  readonly rows: readonly ExplainRow[];
}

export interface SubjectExplanation {
  readonly subject: string;
  readonly kind: SubjectKind;
  readonly grantingRoles: readonly string[];
  readonly declarations: readonly DeclarationExplanation[];
}

/** The matrix half of a declaration: the rows, and whether they mean anything at all. */
type DeclarationMatrix = Pick<DeclarationExplanation, 'decidable' | 'rows'>;

/**
 * One `testActor` per declared role plus the anonymous caller — the same actor set the `/_x`
 * policy panel asks about (`devActors`, `dev-policy.ts`). Reusing it is the point: a second
 * "every role plus anonymous" builder here is the duplicate axiom 1 bans, and it would drift
 * from the panel's own set the first time a role is renamed.
 *
 * With `--input` the policy is evaluated on it, actor by actor inside a `try`: `policyMatrix` does
 * not catch, and a row rule dereferencing the row this command has none of threw a bare
 * `TypeError` straight out of `x policy explain`. One throw makes the whole declaration
 * undecidable rather than half-reported.
 */
const matrixFor = (policy: Policy, options: ExplainOptions): DeclarationMatrix => {
  const { input } = options;
  if (input === undefined) {
    return { decidable: true, rows: devActors().map((actor) => rowWithoutInput(policy, actor)) };
  }
  const rows: ExplainRow[] = [];
  for (const actor of devActors()) {
    try {
      const matrix = policyMatrix(policy, { actors: [actor], input: input.value });
      rows.push(...matrix.rows.map(decided));
    } catch {
      return { decidable: false, rows: [] };
    }
  }
  return { decidable: true, rows };
};

const explainAction = (action: AnyAction, options: ExplainOptions): DeclarationExplanation => {
  const descriptor = action.describe();
  return {
    name: descriptor.name,
    kind: 'action',
    capability: descriptor.capability,
    permissions: descriptor.permissions,
    label: action.policy.label,
    ...matrixFor(action.policy, options),
  };
};

const explainQuery = (query: AnyQuery, options: ExplainOptions): DeclarationExplanation => {
  const descriptor = query.describe();
  return {
    name: descriptor.name,
    kind: 'query',
    capability: descriptor.capability,
    permissions: descriptor.permissions,
    label: query.policy.label,
    ...matrixFor(query.policy, options),
  };
};

type Resolved =
  | { readonly kind: 'permission'; readonly permission: string }
  | { readonly kind: 'action'; readonly action: AnyAction }
  | { readonly kind: 'query'; readonly query: AnyQuery };

/** Priority order from the brief: a known permission, then an action, a query, an action path. */
function resolveSubject(name: string): Resolved | undefined {
  if (knownPermissions().includes(name)) return { kind: 'permission', permission: name };
  const action = getAction(name);
  if (action !== undefined) return { kind: 'action', action };
  const query = getQuery(name);
  if (query !== undefined) return { kind: 'query', query };
  const byPath = describeActions().find((descriptor) => descriptor.path === name);
  const pathAction = byPath === undefined ? undefined : getAction(byPath.name);
  return pathAction === undefined ? undefined : { kind: 'action', action: pathAction };
}

/** Every string `x policy explain` accepts — permissions, then action/query names, then paths. */
export function knownPolicySubjects(): readonly string[] {
  const actions = describeActions();
  return [
    ...knownPermissions(),
    ...actions.map((descriptor) => descriptor.name),
    ...describeQueries().map((descriptor) => descriptor.name),
    ...actions.map((descriptor) => descriptor.path),
  ];
}

export function explainPolicy(
  name: string,
  options: ExplainOptions = {},
): SubjectExplanation | undefined {
  const resolved = resolveSubject(name);
  if (resolved === undefined) return undefined;
  if (resolved.kind === 'permission') {
    const { permission } = resolved;
    const declarations = [
      ...describeActions()
        .filter((descriptor) => enforces(descriptor, permission))
        .map((descriptor) => getAction(descriptor.name))
        .filter(isDefined)
        .map((action) => explainAction(action, options)),
      ...describeQueries()
        .filter((descriptor) => enforces(descriptor, permission))
        .map((descriptor) => getQuery(descriptor.name))
        .filter(isDefined)
        .map((query) => explainQuery(query, options)),
    ];
    return {
      subject: name,
      kind: 'permission',
      grantingRoles: rolesGranting(permission),
      declarations,
    };
  }
  const declaration =
    resolved.kind === 'action'
      ? explainAction(resolved.action, options)
      : explainQuery(resolved.query, options);
  return {
    subject: name,
    kind: resolved.kind,
    // The union over every permission the policy references, not a lookup on the label: a
    // composite-guarded action reported NO granting roles at all, which reads as "nobody can do
    // this" about a declaration half the roles in the app can reach.
    grantingRoles: [
      ...new Set(declaration.permissions.flatMap((permission) => rolesGranting(permission))),
    ].sort(),
    declarations: [declaration],
  };
}
