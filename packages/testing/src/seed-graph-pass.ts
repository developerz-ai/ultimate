// The seed graph an exercise pass writes: ONE graph for the whole pass, so a tenantless table
// (`plans`) is seeded once and every primitive's tenants reference those rows, and each primitive
// owns a fresh tenant pair of its own. One graph also means one set of unique keys: per-primitive
// graphs re-inserted the shared rows and collided on their primary keys.

import { isUltimateError, renderCauseValue, renderThrowable, UltimateError } from '@ultimat3/core';
import { seedGraph } from './seed-graph';
import { seedGraphUnsatisfied } from './seed-graph-error';
import type { SeedFactory, SeedGraph, SeedRow, SeedUpdate, SeedWriter } from './seed-graph-plan';
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

const refused = (write: SeedRow | SeedUpdate, error: unknown): unknown => {
  if (isUltimateError(error) && !ROW_REFUSALS.has(error.code)) return error;
  const why = isUltimateError(error) ? `${error.code}: ${error.cause}` : renderThrowable(error);
  return seedGraphUnsatisfied({
    entity: write.entity,
    what: `the database refused a generated row — ${why}`,
    columns: [],
  });
};

/** Every write coded: a row refusal names its factory, an environment failure keeps its own fix. */
const coded = (writer: SeedWriter): SeedWriter => ({
  insert: (row) =>
    writer.insert(row).catch((error: unknown) => Promise.reject(refused(row, error))),
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
  await insertSeedGraph(graph, coded(writer));
  return graph;
}
