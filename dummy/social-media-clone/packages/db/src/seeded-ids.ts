// Which rows the demo's fixture owns, per entity — derived by replaying the seed into a store
// nobody else reads. Split out of `seed.ts` because that file is a 400-row fixture graph, and a
// decorator over the storage seam has no business sharing a file with data.

import type { Driver, EntityCore, Page, Repo, Seed } from '@ultimat3/entity';
import { memoryDriver } from '@ultimat3/entity';

/** Property access on a parsed row without `any`: `$parse` fills every declared column. */
const cellOf = <Row>(row: Row, property: string): unknown =>
  (row as Readonly<Record<string, unknown>>)[property];

/** The row's own primary key value, for the single-column keys every content table here has. */
const idOf = <Row>(entity: EntityCore<Row>, row: Row): string | undefined => {
  const value = cellOf(row, entity.$primaryKey[0] ?? 'id');
  return typeof value === 'string' ? value : undefined;
};

/** Well under `MAX_PAGE_SIZE`, and paged anyway: a truncated read here reads as "not seeded". */
const READ_PAGE = 1_000;

/**
 * Everything one entity holds after the replay, by id.
 *
 * `includeDeleted`, because the fixture owns a soft-deleted post on purpose (`post:deleted`) and an
 * answer that left it out would call a seeded row a visitor's.
 */
const idsIn = async <Row>(entity: EntityCore<Row>, repo: Repo<Row>): Promise<readonly string[]> => {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<Row> = await repo.findMany({ cursor, includeDeleted: true, limit: READ_PAGE });
    for (const row of page.rows) {
      const id = idOf(entity, row);
      if (id !== undefined) ids.push(id);
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return ids;
};

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
 *
 * The store is READ BACK rather than a write verb decorated. A decorator over `repo.insert` is what
 * this was, and `defineSeed` moved to `upsertAll` (packages/entity/src/seed.ts:274) without the map
 * going anywhere but empty — silently, because "no rows are the fixture's" is a legal answer to the
 * caller. This store starts empty and only the seed writes to it, so what it holds IS what the seed
 * wrote, whichever verb the framework's context uses to write it.
 */
export const seededIds = async (seed: Seed): Promise<ReadonlyMap<string, ReadonlySet<string>>> => {
  const base = memoryDriver();
  // The only thing the wrapper adds: the entities the seed touched, which is what a read-back needs
  // and what nothing else can tell us — `Driver` has no "list what you hold".
  const touched = new Map<string, () => Promise<readonly string[]>>();
  const recording: Driver = {
    repo<Row>(entity: EntityCore<Row>): Repo<Row> {
      const repo = base.repo(entity);
      touched.set(entity.$name, () => idsIn(entity, repo));
      return repo;
    },
  };
  await seed.run({ driver: recording });
  const collected = new Map<string, ReadonlySet<string>>();
  for (const [name, read] of touched) {
    const ids = await read();
    // An entity the seed only READ (a sentinel `exists`) resolves each repo but writes no row, and
    // an empty set there would read as "the fixture owns nothing here" rather than "not a table
    // this fixture writes". Same answer to the caller, one fewer entry to explain.
    if (ids.length > 0) collected.set(name, new Set(ids));
  }
  return collected;
};
