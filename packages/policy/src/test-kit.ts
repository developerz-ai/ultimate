// `policyMatrix()` turns "who can do this?" into a table a test can assert on in one
// expression. `x g policy` generates a test that calls it, so every policy ships with
// its allow/deny matrix and a change to a role shows up as a diff in that table.
import { type EvaluateArgs, evaluate, reasonOf } from './evaluate';
import type { Policy } from './policy';
import type { Actor } from './roles';

export interface NamedActor {
  readonly name: string;
  readonly actor: Actor | null;
}

export interface MatrixRow {
  readonly actor: string;
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly deciding: string | null;
}

export interface PolicyMatrix {
  readonly label: string;
  readonly rows: readonly MatrixRow[];
  /** `{ owner: true, viewer: false }` — the shape an assertion reads best. */
  readonly verdicts: Readonly<Record<string, boolean>>;
  allowedFor(name: string): boolean;
  /** Fixed-width table for a snapshot test or the dev dashboard. */
  toTable(): string;
}

/** Everything `evaluate` takes except the actor — `row` included, so a row rule is testable. */
export interface MatrixArgs<I, R = unknown> extends Omit<EvaluateArgs<I, R>, 'actor'> {
  readonly actors: readonly NamedActor[];
}

export const policyMatrix = <I, R = unknown>(
  policy: Policy<I, R>,
  args: MatrixArgs<I, R>,
): PolicyMatrix => {
  const rows = args.actors.map((entry): MatrixRow => {
    // Every field but the actor is forwarded verbatim: a matrix that dropped `row` would
    // report a row rule as denying everyone, and the table would lie.
    const evaluation = evaluate(
      policy,
      {
        input: args.input,
        actor: entry.actor,
        ...(args.row === undefined ? {} : { row: args.row }),
        ...(args.ctx === undefined ? {} : { ctx: args.ctx }),
      },
      // The `deciding` column IS the matrix; a production default that skips the trace would
      // blank it, and `x policy explain` renders this table.
      { trace: true },
    );
    return {
      actor: entry.name,
      allowed: evaluation.allowed,
      reason: reasonOf(evaluation.decision),
      deciding: evaluation.deciding?.label ?? null,
    };
  });

  // `Object.fromEntries` rather than `verdicts[row.actor] = …`: an actor named `__proto__` assigns
  // the PROTOTYPE through that spelling and files no key at all, so the matrix would report a
  // verdict it never stored. Every name here is an own key.
  const verdicts: Record<string, boolean> = Object.fromEntries(
    rows.map((row) => [row.actor, row.allowed]),
  );

  const width = Math.max(5, ...rows.map((row) => row.actor.length));
  return {
    label: policy.label,
    rows,
    verdicts,
    // `verdicts[name] ?? false` answered the `Object` FUNCTION — truthy, and not a boolean — for
    // `allowedFor('constructor')`, so a matrix asserting on an actor of that name read as allow.
    allowedFor: (name) => (Object.hasOwn(verdicts, name) ? verdicts[name] === true : false),
    toTable: () =>
      rows
        .map((row) =>
          `${row.actor.padEnd(width)}  ${row.allowed ? 'allow' : 'deny '}  ${row.reason ?? ''}`.trimEnd(),
        )
        .join('\n'),
  };
};

/**
 * Builds a COMPLETE actor for tests — `kind` and `scopes` included.
 *
 * It used to omit both behind an `as unknown as Actor`, and neither is decoration: `hasScope()`
 * reads `actor.scopes.includes(…)` and threw a bare `TypeError` on every actor this minted, and
 * `actorLabel()` rendered `undefined:editor` into logs and spans. A generated policy test
 * (`x g policy`) asserting a scope-gated denial therefore failed as a 500-shaped throw rather
 * than as a denial — the exact confusion `surfaces.ts` exists to prevent.
 */
export const testActor = (
  name: string,
  init: {
    roles?: readonly string[];
    permissions?: readonly string[];
    scopes?: readonly string[];
    orgId?: string;
  } = {},
): NamedActor => {
  const base: Actor = {
    kind: 'user',
    id: name,
    roles: init.roles ?? [],
    scopes: init.scopes ?? [],
    permissions: init.permissions ?? [],
  };
  // `orgId: null` is deliberate and load-bearing, and the ONE cast left here. `Actor` is
  // `CoreActor & PolicyActorFields`, and that intersection collapses `PolicyActorFields`'s
  // `string | null | undefined` back to core's `string | undefined` — so nothing else in the repo
  // can produce the `null` an app's own adapter still puts on the wire, and
  // `@ultimat3/query`'s `orgless()` needs a producer of it to stay honest.
  return { name, actor: { ...base, orgId: init.orgId ?? null } as Actor };
};
