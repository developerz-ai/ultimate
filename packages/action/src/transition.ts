/**
 * `transition()` — a MUTATOR factory over one entity column's state machine. Not a ninth primitive:
 * a move is a server-authoritative write with an input schema, an output schema and a policy, which
 * is what a `mutator` already is, so this RETURNS one and inherits the route, the OpenAPI operation,
 * the typed client, the MCP tool, the job handle and its manifest row.
 *
 * It lives here and not in `@ultimat3/entity` because `mutator()` is tier 3 and entity is tier 2 —
 * the same relationship `search()` has to `@ultimat3/query`. The mechanism underneath is entity's:
 * this file makes no legality decision and answers no refusal of its own.
 */

import type { Ctx } from '@ultimat3/core';
import type {
  InferOutput,
  ObjectSchema,
  Schema,
  StandardSchemaV1,
  StringSchema,
} from '@ultimat3/schema';
import { t } from '@ultimat3/schema';
import { type LocalRow, type Mutator, mutator } from './mutator';
import type { ActionPolicy } from './policy-gate';

/**
 * The one method this factory calls, declared structurally: `@ultimat3/entity`'s `Table.transition`
 * satisfies it as written. Structural and not an import because `@ultimat3/action` holds no
 * dependency edge on `@ultimat3/entity` — the tier table permits one (2 is below 3), the manifest
 * and the lockfile do not — the same trade `@ultimat3/db`'s `entity-shape.ts` makes one tier down.
 *
 * `id` is a plain `string` rather than entity's `IdOf<Row>`: that alias "collapses to `string` for
 * every unbranded entity" by its own account, and a branded one still satisfies this because a
 * method's parameters compare bivariantly. The input schema mints a `string`, so declaring anything
 * narrower here would buy a cast and nothing else.
 */
/**
 * The input every transition takes, spelled once: the row, the state the caller believes it is in,
 * and the state it wants. Named because it is what the typed client and the MCP tool are typed by.
 */
/** The parsed input, spelled concretely — what `TransitionInput<S>` reduces to at every call site. */
export interface TransitionValues<S extends string> {
  readonly id: string;
  readonly from: S;
  readonly to: S;
}

export type TransitionInput<S extends string> = ObjectSchema<{
  readonly id: StringSchema;
  readonly from: Schema<S, S>;
  readonly to: Schema<S, S>;
}>;

export interface TransitionTarget<Row, S extends string> {
  transition(column: string, id: string, move: { readonly from: S; readonly to: S }): Promise<Row>;
}

export interface TransitionDef<
  TOutput extends StandardSchemaV1,
  Row extends InferOutput<TOutput> & object,
  K extends keyof Row & string,
  S extends Row[K] & string,
> {
  /** The request's table — `(ctx) => posts(ctx)`, so the move is tenant-scoped like every write. */
  readonly table: (ctx: Ctx) => TransitionTarget<Row, S>;
  /** The column whose `enumerated().transitions()` declaration IS the machine. */
  readonly column: K;
  /**
   * The states, as the input schema. Typed `Row[K]`, so a state the row cannot hold is a compile
   * error here — and every projection inherits the enum: OpenAPI documents the legal set, the MCP
   * tool's `inputSchema` carries it, the typed client refuses a typo at COMPILE time, and a
   * misspelled state is `X_INPUT_INVALID` before the request reaches a database.
   *
   * It is the one thing restated from the column's own declaration, and the reason is a boundary:
   * reading the machine off the entity needs `@ultimat3/entity` as a real dependency of this
   * package. Listing a SUBSET refuses a legal move at the input schema — loud, and the fix is the
   * enum in the refusal.
   */
  readonly states: readonly [S, ...S[]];
  /** The local store's name for this entity — what the optimistic twin patches. */
  readonly localTable: string;
  /** The projection the caller gets back. Unknown keys are dropped by the parse, so a `$view` works. */
  readonly output: TOutput;
  readonly policy: ActionPolicy;
  /**
   * OFF unless the app says otherwise, and deliberately not `?? true`.
   *
   * A transition is exactly the kind of event an audit sink is for — and `audit: true` with no sink
   * installed is `X_AUDIT_SINK_MISSING`, raised before the input parse. Defaulting it on would make
   * every `transition()` refuse in an app that has not made a separate, unrelated decision, which is
   * a framework default holding the feature hostage. What the row is kept for, and for how long, is
   * the same compliance question that kept a purge out of `postgresAuditSink`.
   */
  readonly audit?: boolean;
}

/**
 * `from` is REQUIRED and is never defaulted or inferred. It rides in the UPDATE's own predicate, so
 * the state observed and the state written are one decision under the row's lock — optimistic
 * concurrency in the ETag shape. Measured on the mechanism underneath: twenty concurrent moves at
 * one row produced 14 winners with a read-then-check-then-write, and 1 winner plus 19 refusals with
 * `from` in the predicate. Anything that supplies `from` on the caller's behalf is the lost update
 * coming back.
 */
export function transition<
  TOutput extends StandardSchemaV1,
  Row extends InferOutput<TOutput> & object,
  K extends keyof Row & string,
  const S extends Row[K] & string,
>(def: TransitionDef<TOutput, Row, K, S>): Mutator<TransitionInput<S>, TOutput> {
  const state = t.enum(def.states);
  // ONE cast, and it is a compiler limitation rather than an unknown value: `t.object`'s output is
  // a mapped type over its shape, and a mapped type does not reduce while a type parameter is still
  // open — so `input.id` is unreachable INSIDE this function even though every call site resolves
  // it exactly. `@ultimat3/entity`'s `transitionRow` spells its own patch this way for the same
  // reason. What arrives here has already been parsed by the schema two lines up, and nothing else
  // can reach these two callbacks.
  const valuesOf = (raw: unknown): TransitionValues<S> => raw as TransitionValues<S>;
  return mutator({
    input: t.object({ id: t.uuid, from: state, to: state }),
    output: def.output,
    policy: def.policy,
    ...(def.audit === undefined ? {} : { audit: def.audit }),
    // Never overridable: the server is the half that REFUSED the move, and a local twin that won
    // the rebase would leave the client showing a state the database rejected.
    conflict: 'server-wins',
    local: (tx, raw) => {
      const input = valuesOf(raw);
      // `as Partial<…>`: a computed key widens to an index signature, which is never assignable to
      // a `Partial` of a type parameter. `def.column` is `keyof Row`, so the shape is a real one.
      tx.table<Row & LocalRow>(def.localTable).update(input.id, {
        [def.column]: input.to,
      } as Partial<Row & LocalRow>);
    },
    // No cast on `from`/`to`: they are the enum's own union, which is `Row[K]`. And no legality
    // check here — `X_STATE_TRANSITION_ILLEGAL`, `X_STATE_CONFLICT` and `X_STATE_UNDECLARED` are
    // entity's and propagate as they are. A second error class over one failure is a second path.
    server: (ctx, raw) => {
      const input = valuesOf(raw);
      return def.table(ctx).transition(def.column, input.id, {
        from: input.from,
        to: input.to,
      });
    },
  });
}
