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
import type { TransitionObservation } from '@ultimat3/entity';
import type {
  InferOutput,
  ObjectSchema,
  Schema,
  StandardSchemaV1,
  StringSchema,
} from '@ultimat3/schema';
import { nodeOf, t } from '@ultimat3/schema';
import type { ActionRowArgs } from './action';
import { type Mutator, mutator } from './mutator';
import type { ActionPolicy } from './policy-gate';
import { observeRow, takeObservation } from './transition-observe';

/**
 * The one method this factory calls, declared structurally: `@ultimat3/entity`'s `Table.transition`
 * satisfies it as written. Structural because it is all this file needs of a table — one method —
 * and a fake that implements it is the whole test seam; the package does import entity elsewhere.
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
  transition(
    column: string,
    id: string,
    move: { readonly from: S; readonly to: S; readonly observed?: TransitionObservation },
  ): Promise<Row>;
}

export interface TransitionDef<
  TOutput extends StandardSchemaV1,
  Row extends InferOutput<TOutput> & object,
  K extends keyof Row & string,
  S extends Row[K] & string,
  TRow = unknown,
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
   * It is the one thing restated from the column's own declaration: `table` is resolved per request
   * (`(ctx) => …`), and the input schema is needed at declaration, before any table exists to read
   * a machine off. Listing a SUBSET refuses a legal move at the input schema — loud, and the fix is
   * the enum in the refusal.
   */
  readonly states: readonly [S, ...S[]];
  /** The local store's name for this entity — what the optimistic twin patches. */
  readonly localTable: string;
  /** The projection the caller gets back. Unknown keys are dropped by the parse, so a `$view` works. */
  readonly output: TOutput;
  /**
   * The key's schema, for an `output` that does not carry the key as `id`. Omitted — the usual
   * case — it is read off `output.id` (`keySchemaOf`), which for an entity `$view` IS the key
   * column's own shape.
   */
  readonly id?: StringSchema;
  readonly policy: ActionPolicy<TRow>;
  /**
   * The row a row-level `policy` decides about — an action's own `row` loader, handed through
   * unchanged: loaded once, after the input parse, before the guard and before the statement. The
   * factory reads no row itself; which columns a rule needs (an `authorId` the `output` view may not
   * carry) is the app's. Omitted, the rule sees `row: null` — and must fail closed on it.
   *
   * The DECISION rides in the compare-and-set (#702). The rule is handed a view of the loaded row
   * that records which properties it read; the move then carries the row and that list to
   * `Table.transition` (`observed`), which pins every one that is a plain column of the moved row
   * beside `id` and `from`. An `authorId` reassigned between the read and the move — committed
   * first, or in flight and waited on — matches no statement: `X_STATE_CONFLICT`, naming the
   * column, and the row does not move. A column the rule never read may change freely.
   *
   * What is NOT pinned, by entity's rules (`transition-pins.ts`): a row carrying a key that is not
   * the moved row's (a loader that reads a parent record — a keyless projection IS this row), a
   * property that names no column, and a `timestamptz`, `jsonb`, array, `bytea`, money or sealed
   * column — none has an `=` that means one thing in both drivers. Nor, by this factory's: a column
   * read INSIDE a getter or method of a class-shaped row (only the accessor's own name is recorded,
   * and it runs against the unobserved row) — return a plain row from the loader. A rule that
   * decides on any of those, or on another table's rows, decides on a read the statement cannot
   * re-check.
   */
  row?(args: ActionRowArgs<TransitionInput<S>>): TRow | null | Promise<TRow | null>;
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
  TRow = unknown,
>(def: TransitionDef<TOutput, Row, K, S, TRow>): Mutator<TransitionInput<S>, TOutput> {
  const state = t.enum(def.states);
  // ONE cast, and it is a compiler limitation rather than an unknown value: `t.object`'s output is
  // a mapped type over its shape, and a mapped type does not reduce while a type parameter is still
  // open — so `input.id` is unreachable INSIDE this function even though every call site resolves
  // it exactly. `@ultimat3/entity`'s `transitionRow` spells its own patch this way for the same
  // reason. What arrives here has already been parsed by the schema two lines up, and nothing else
  // can reach these two callbacks.
  const valuesOf = (raw: unknown): TransitionValues<S> => raw as TransitionValues<S>;
  const row = def.row;
  return mutator<TransitionInput<S>, TOutput, TRow>({
    input: t.object({ id: def.id ?? keySchemaOf(def.output), from: state, to: state }),
    output: def.output,
    policy: def.policy,
    // A compare-and-set move replayed under its key answers the first outcome, never a second
    // `X_STATE_CONFLICT` for a move that already happened.
    idempotent: true,
    // `.call(def, …)`, as `mutator()` hands its own on: a loader written as a method keeps `this`.
    // The row is remembered for `server` below and the rule sees a view recording what it reads.
    ...(row === undefined
      ? {}
      : { row: async (args) => observeRow(args.input, await row.call(def, args)) }),
    ...(def.audit === undefined ? {} : { audit: def.audit }),
    // Never overridable: the server is the half that REFUSED the move, and a local twin that won
    // the rebase would leave the client showing a state the database rejected.
    conflict: 'server-wins',
    local: (tx, raw) => {
      const input = valuesOf(raw);
      // `as Partial<…>`: a computed key widens to an index signature, which is never assignable to
      // a `Partial` of a type parameter. `def.column` is `keyof Row`, so the shape is a real one.
      tx.table<Row>(def.localTable).update(input.id, {
        [def.column]: input.to,
      } as Partial<Row>);
    },
    // No cast on `from`/`to`: they are the enum's own union, which is `Row[K]`. And no legality
    // check here — `X_STATE_TRANSITION_ILLEGAL`, `X_STATE_CONFLICT` and `X_STATE_UNDECLARED` are
    // entity's and propagate as they are. A second error class over one failure is a second path.
    server: (ctx, raw) => {
      const input = valuesOf(raw);
      const observed = takeObservation(raw);
      return def.table(ctx).transition(def.column, input.id, {
        from: input.from,
        to: input.to,
        ...(observed === undefined ? {} : { observed }),
      });
    },
  });
}

/**
 * The `id` a move takes, from the key the OUTPUT declares — never a fixed `t.uuid`, which made
 * every call on an entity keyed by `text()` or `bigint()` `X_INPUT_INVALID` while the mechanism
 * underneath addresses any single-column key. An entity `$view` builds its `id` node from the key
 * column, so the bounds copied here are that column's: a uuid stays a uuid (and a malformed one is
 * still refused before a database reads it), a `bigint()` keeps its digits pattern, a `text()` its
 * length. Never empty: an empty string names no row. An output with no string `id` keeps the
 * framework's default key type, `uuid().primaryKey()`.
 */
function keySchemaOf(output: StandardSchemaV1): StringSchema {
  const key = nodeOf(output)?.properties?.['id'];
  if (key === undefined || key.kind !== 'string' || key.format === 'uuid') return t.uuid;
  let schema = t.string.min(Math.max(1, key.minLength ?? 1));
  if (key.maxLength !== undefined) schema = schema.max(key.maxLength);
  if (key.pattern !== undefined) schema = schema.pattern(new RegExp(key.pattern, key.patternFlags));
  return schema;
}
