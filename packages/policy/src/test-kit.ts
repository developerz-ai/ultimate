// `policyMatrix()` turns "who can do this?" into a table a test can assert on in one
// expression. `x g policy` generates a test that calls it, so every policy ships with
// its allow/deny matrix and a change to a role shows up as a diff in that table.
import { userActor } from '@ultimat3/core';
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
 * Builds a test actor through `userActor()` — core's own builder, and now the only one, since
 * `permissions` moved to core's `Actor` (`As of 2026-08-19`).
 *
 * This function hand-rolled the object literal because it had to: a direct grant was declared on
 * policy's `PolicyActorFields` and core's builder had no field for it. That is what made every
 * actor it minted structurally different from a request's — it omitted `kind` and `scopes` behind
 * an `as unknown as Actor`, so `hasScope()` threw a bare `TypeError` and `actorLabel()` rendered
 * `undefined:editor` into logs and spans, and a generated policy test (`x g policy`) asserting a
 * scope-gated denial failed as a 500-shaped throw rather than as the denial it wrote.
 *
 * Going through `userActor()` closes that by construction rather than by keeping a second field
 * list in sync: a field added to `Actor` arrives here, and the result is FROZEN with frozen
 * arrays, exactly as the actor `@ultimat3/auth` resolves per request is.
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
  const built = userActor({
    id: name,
    roles: init.roles ?? [],
    scopes: init.scopes ?? [],
    permissions: init.permissions ?? [],
  });
  // `orgId: null` is deliberate and load-bearing, and the ONE cast left. Core declares
  // `orgId?: string | undefined`, so nothing typed can mint the `null` an app's own adapter still
  // puts on the wire — and `@ultimat3/query`'s `orgless()` treats `null`, `undefined` and `''`
  // alike precisely because it does reach there. Frozen, so this stays a production-shaped actor.
  return { name, actor: Object.freeze({ ...built, orgId: init.orgId ?? null }) as Actor };
};
