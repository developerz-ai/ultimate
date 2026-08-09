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
    const evaluation = evaluate(policy, {
      input: args.input,
      actor: entry.actor,
      ...(args.row === undefined ? {} : { row: args.row }),
      ...(args.ctx === undefined ? {} : { ctx: args.ctx }),
    });
    return {
      actor: entry.name,
      allowed: evaluation.allowed,
      reason: reasonOf(evaluation.decision),
      deciding: evaluation.deciding?.label ?? null,
    };
  });

  const verdicts: Record<string, boolean> = {};
  for (const row of rows) verdicts[row.actor] = row.allowed;

  const width = Math.max(5, ...rows.map((row) => row.actor.length));
  return {
    label: policy.label,
    rows,
    verdicts,
    allowedFor: (name) => verdicts[name] ?? false,
    toTable: () =>
      rows
        .map((row) =>
          `${row.actor.padEnd(width)}  ${row.allowed ? 'allow' : 'deny '}  ${row.reason ?? ''}`.trimEnd(),
        )
        .join('\n'),
  };
};

/** Builds an actor for tests without asserting anything about core's Actor shape. */
export const testActor = (
  name: string,
  init: { roles?: readonly string[]; permissions?: readonly string[]; orgId?: string } = {},
): NamedActor => ({
  name,
  actor: {
    id: name,
    roles: init.roles ?? [],
    permissions: init.permissions ?? [],
    orgId: init.orgId ?? null,
  } as unknown as Actor,
});
