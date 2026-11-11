// The seed graph an exercise pass writes: ONE graph for the whole pass, so a tenantless table
// (`plans`) is seeded once and every primitive's tenants reference those rows, and each primitive
// owns a fresh tenant pair of its own. One graph also means one set of unique keys: per-primitive
// graphs re-inserted the shared rows and collided on their primary keys.

import { isUltimateError, renderCauseValue, renderThrowable, UltimateError } from '@ultimat3/core';
import { seedGraph } from './seed-graph';
import { seedGraphUnsatisfied } from './seed-graph-error';
import type {
  SeedCanary,
  SeedFactory,
  SeedGraph,
  SeedRow,
  SeedUpdate,
  SeedWriter,
} from './seed-graph-plan';
import { insertSeedGraph } from './seed-graph-plan';
import type { SeedEntity } from './seed-graph-shape';

/** Tenants per primitive: the actor's own, and a second the tenant proof reads across. */
export const TENANTS_PER_PRIMITIVE = 2;

/**
 * The database refused a row the graph generated: a rule the declaration does not carry (a
 * trigger, a hand-written CHECK). The row is the app's to describe, so the factory is the fix.
 * Anything else coded — `X_SEAL_KEY_MISSING`, `X_DB_UNAVAILABLE` — keeps its own code and fix.
 */
const ROW_REFUSALS: ReadonlySet<string> = new Set([
  'X_DB_UNIQUE_VIOLATION',
  'X_DB_FOREIGN_KEY_VIOLATION',
  'X_DB_STATEMENT_FAILED',
]);

/** Postgres' 23514 for a row whose partition key no partition covers, in its own words. */
const NO_PARTITION = 'no partition of relation';

const refused = (write: SeedRow | SeedUpdate, error: unknown): unknown => {
  if (isUltimateError(error) && !ROW_REFUSALS.has(error.code)) return error;
  const why = isUltimateError(error) ? `${error.code}: ${error.cause}` : renderThrowable(error);
  if (why.includes(NO_PARTITION)) {
    // No factory repairs this: the database's partitions stop short of the seed's anchor — made
    // around a migrate long past (or a clock other than the seed's) and never kept ahead since.
    return seedGraphUnsatisfied({
      entity: write.entity,
      what: `the database holds no partition for a generated row — ${why}. The seed anchors a partitionBy column on its clock's now; the partitions were made around the migration's apply time and are kept ahead only by the app's partitions() job`,
      columns: [],
      fix: "await maintainPartitions.enqueue({})   # the app's partitions() job — makes every partition up to now and its ahead; or pass seedGraph(entities, { now }) the database's select now()",
    });
  }
  return seedGraphUnsatisfied({
    entity: write.entity,
    what: `the database refused a generated row — ${why}`,
    columns: [],
  });
};

const refusedRow = (error: unknown): boolean =>
  !isUltimateError(error) || ROW_REFUSALS.has(error.code) || error.code === 'X_ENTITY_APPEND_ONLY';

/**
 * A deferred key the database refuses to set is left null: only a nullable key is ever deferred
 * (`seed-graph-order.ts`), so the row as inserted is already a valid one. The refusal is a rule no
 * declaration carries — a trigger that refuses every UPDATE of the table. An environment failure
 * still rejects with its own code. `onRefused` hears each update left out.
 */
export const deferredMayStayNull = (
  writer: SeedWriter,
  onRefused: (update: SeedUpdate) => void = () => undefined,
): SeedWriter => ({
  insert: (row) => writer.insert(row),
  ...(writer.insertMany === undefined
    ? {}
    : { insertMany: (rows: readonly SeedRow[]) => writer.insertMany?.(rows) ?? Promise.resolve() }),
  update: (update) =>
    writer.update(update).catch((error: unknown) => {
      if (!refusedRow(error)) return Promise.reject(error);
      onRefused(update);
    }),
  snapshot: (rows) => writer.snapshot(rows),
});

/** Every write coded: a row refusal names its factory, an environment failure keeps its own fix. */
const coded = (writer: SeedWriter): SeedWriter => ({
  insert: (row) =>
    writer.insert(row).catch((error: unknown) => Promise.reject(refused(row, error))),
  ...(writer.insertMany === undefined
    ? {}
    : {
        insertMany: (rows: readonly SeedRow[]) =>
          (writer.insertMany?.(rows) ?? Promise.resolve()).catch((error: unknown) =>
            Promise.reject(refused(rows[0] as SeedRow, error)),
          ),
      }),
  update: (update) =>
    writer.update(update).catch((error: unknown) => Promise.reject(refused(update, error))),
  // A read, not a write: nothing a database refuses here is the generated row's fault.
  snapshot: (rows) => writer.snapshot(rows),
});

/** The tenant pair primitive `index` (0-based, in run order) acts in. */
export const tenantPair = (graph: SeedGraph, index: number): readonly [string, string] => [
  graph.tenants[index * TENANTS_PER_PRIMITIVE] as string,
  graph.tenants[index * TENANTS_PER_PRIMITIVE + 1] as string,
];

interface TenantIndex {
  readonly inserts: ReadonlyMap<string | null, readonly number[]>;
  readonly updates: ReadonlyMap<string | null, readonly SeedUpdate[]>;
}

const indexes = new WeakMap<SeedGraph, TenantIndex>();

const grouped = <T>(items: readonly T[], tenantOf: (item: T) => string | null) => {
  const out = new Map<string | null, T[]>();
  for (const item of items) {
    const key = tenantOf(item);
    const bucket = out.get(key);
    if (bucket === undefined) out.set(key, [item]);
    else bucket.push(item);
  }
  return out;
};

const indexOf = (graph: SeedGraph): TenantIndex => {
  let index = indexes.get(graph);
  if (index === undefined) {
    const positions = graph.inserts.map((_, i) => i);
    index = {
      inserts: grouped(positions, (i) => (graph.inserts[i] as SeedRow).tenant),
      updates: grouped(graph.updates, (update) => update.tenant),
    };
    indexes.set(graph, index);
  }
  return index;
};

/**
 * What primitive `index` can see of the pass's graph: the rows of no tenant and its own pair's —
 * the same rows, in the same order, `canaries` still aligned. Everything a primitive reads off the
 * graph (ids to bind, its taint, its actor rows) reads this, so its cost is its pair's, never the
 * whole pass's: a filter of every row per primitive was primitives² over the pass.
 */
export function pairGraph(graph: SeedGraph, index: number): SeedGraph {
  const pair = tenantPair(graph, index);
  const { inserts, updates } = indexOf(graph);
  const at = [null, ...pair].flatMap((tenant) => inserts.get(tenant) ?? []).sort((a, b) => a - b);
  return {
    seed: graph.seed,
    tenants: pair,
    order: graph.order,
    inserts: at.map((i) => graph.inserts[i] as SeedRow),
    canaries: at.map((i) => graph.canaries[i] as SeedCanary),
    updates: [null, ...pair].flatMap((tenant) => updates.get(tenant) ?? []),
  };
}

/** A factory keyed by a name no seeded entity has would build nothing, and the red would stay. */
const unknownFactory = (names: readonly string[], known: ReadonlySet<string>): UltimateError =>
  new UltimateError({
    code: 'X_DECLARATION_UNKNOWN',
    cause: `defineExercise() factories name ${names.map((name) => renderCauseValue(name)).join(', ')}, which no seeded entity is called (seeded: ${renderCauseValue([...known].sort().join(', '))})`,
    fix: "defineExercise({}, { factories: { '<the name entity(...) was declared with>': thatFactory } })   # in apps/web/exercise.ts; the seeded names are in the cause",
    meta: { unknown: names, registered: [...known].sort() },
  });

/**
 * Plan and write the pass's graph: shared rows once, `TENANTS_PER_PRIMITIVE` tenants per
 * primitive. Same seed, same rows. Before any primitive runs, so a failure refuses the pass.
 */
export async function seedPass(
  entities: readonly SeedEntity[],
  writer: SeedWriter,
  options: {
    readonly primitives: number;
    readonly seed: number;
    readonly factories?: Readonly<Record<string, SeedFactory>>;
  },
): Promise<SeedGraph> {
  const known = new Set(entities.map((entity) => entity.$name));
  const unknown = Object.keys(options.factories ?? {}).filter((name) => !known.has(name));
  if (unknown.length > 0) throw unknownFactory(unknown, known);
  const graph = seedGraph(Object.fromEntries(entities.map((entity) => [entity.$name, entity])), {
    tenants: Math.max(1, options.primitives) * TENANTS_PER_PRIMITIVE,
    seed: options.seed,
    ...(options.factories === undefined ? {} : { factories: options.factories }),
  });
  const refused = new Set<SeedUpdate>();
  await insertSeedGraph(graph, coded(deferredMayStayNull(writer, (update) => refused.add(update))));
  // What was written: an update the database refused is no part of the seeded state.
  return refused.size === 0
    ? graph
    : { ...graph, updates: graph.updates.filter((update) => !refused.has(update)) };
}
