// Two decorators over a `Driver`, both for the seed: one makes its inserts replayable, the other
// records the ids it writes without storing anything. Split out of `seed.ts` because that file is a
// 400-row fixture graph, and a decorator over the storage seam has no business sharing a file with
// data.

import type { Driver, EntityCore, Repo } from '@ultimat3/entity';
import { memoryDriver } from '@ultimat3/entity';

/** Property access on a parsed row without `any`: `$parse` fills every declared column. */
const cellOf = <Row>(row: Row, property: string): unknown =>
  (row as Readonly<Record<string, unknown>>)[property];

/** The row's own primary key value, for the single-column keys every content table here has. */
const idOf = <Row>(entity: EntityCore<Row>, row: Row): string | undefined => {
  const value = cellOf(row, entity.$primaryKey[0] ?? 'id');
  return typeof value === 'string' ? value : undefined;
};

/**
 * `defineSeed`'s context offers `insert` and nothing else (packages/entity/src/seed.ts:63), and a
 * plain insert means two different things to the two drivers: the memory repository overwrites by
 * primary key, Postgres raises `23505`. Every claim in this app that replaying the seed is a no-op
 * (`apps/web/api/index.ts`, `apps/web/app/tasks/repo.ts`) was written against the first meaning, so
 * on a durable store the SECOND boot of any role container would have crashed on the first demo
 * user — and the four role containers boot at once, so the first would have raced the other three.
 * `on conflict do update` is one statement and settles that race in the server.
 */
export const replayable = (base: Driver): Driver => ({
  repo<Row>(entity: EntityCore<Row>): Repo<Row> {
    const repo = base.repo(entity);
    return {
      ...repo,
      async insert(values, options) {
        const [written] = await repo.upsertAll([values], {
          ...options,
          // The entity's own declared key, narrowed to what `onConflict` names: `$primaryKey` is
          // `readonly string[]` because an entity does not know its own row type at that field.
          onConflict: entity.$primaryKey as readonly (keyof Row & string)[],
          onMatch: 'update',
        });
        return written ?? values;
      },
    };
  },
});

/**
 * Every id the seed writes, per entity name — DERIVED by replaying the fixture into a store nobody
 * reads, never a hand-kept list beside it.
 *
 * `restoreSeededGraph` is the caller, and the question it asks is "which of these rows did a
 * visitor create". It matters because `posts` and `comments` are soft-deletable: deleting a seeded
 * row stamps it, and no upsert can clear that stamp again — `upsertPlan` spares the soft-delete
 * column on purpose (packages/entity/src/bulk-write.ts:219), and the memory driver refuses to
 * address a stamped row at all (packages/entity/src/repo.ts:300). So a reset that deleted the
 * seeded posts and replayed the seed left the demo's feed permanently empty. It no longer deletes
 * them.
 */
export const seededIds = async (seed: {
  run(options: { driver: Driver }): Promise<void>;
}): Promise<ReadonlyMap<string, ReadonlySet<string>>> => {
  const base = memoryDriver();
  const collected = new Map<string, Set<string>>();
  const recording: Driver = {
    repo<Row>(entity: EntityCore<Row>): Repo<Row> {
      const repo = base.repo(entity);
      // `$name` is what `CONTENT_TABLES` calls the table, because both are the entity's own name.
      const name = entity.$name;
      return {
        ...repo,
        async insert(values, options) {
          const id = idOf(entity, values);
          if (id !== undefined) {
            const bucket = collected.get(name);
            if (bucket === undefined) collected.set(name, new Set([id]));
            else bucket.add(id);
          }
          return repo.insert(values, options);
        },
      };
    },
  };
  await seed.run({ driver: recording });
  return collected;
};
