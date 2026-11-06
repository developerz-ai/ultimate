// The seed graph an exercise pass writes: ONE graph for the whole pass, so a tenantless table
// (`plans`) is seeded once and every primitive's tenants reference those rows, and each primitive
// owns a fresh tenant pair of its own. One graph also means one set of unique keys: per-primitive
// graphs re-inserted the shared rows and collided on their primary keys.

import { isUltimateError, renderThrowable } from '@ultimat3/core';
import { seedGraph } from './seed-graph';
import { seedGraphUnsatisfied } from './seed-graph-error';
import type { SeedGraph, SeedRow, SeedUpdate, SeedWriter } from './seed-graph-plan';
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
});

/** The tenant pair primitive `index` (0-based, in run order) acts in. */
export const tenantPair = (graph: SeedGraph, index: number): readonly [string, string] => [
  graph.tenants[index * TENANTS_PER_PRIMITIVE] as string,
  graph.tenants[index * TENANTS_PER_PRIMITIVE + 1] as string,
];

/**
 * Plan and write the pass's graph: shared rows once, `TENANTS_PER_PRIMITIVE` tenants per
 * primitive. Same seed, same rows. Before any primitive runs, so a failure refuses the pass.
 */
export async function seedPass(
  entities: readonly SeedEntity[],
  writer: SeedWriter,
  options: { readonly primitives: number; readonly seed: number },
): Promise<SeedGraph> {
  const graph = seedGraph(Object.fromEntries(entities.map((entity) => [entity.$name, entity])), {
    tenants: Math.max(1, options.primitives) * TENANTS_PER_PRIMITIVE,
    seed: options.seed,
  });
  await insertSeedGraph(graph, coded(writer));
  return graph;
}
