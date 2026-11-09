// `entitySeedWriter`: the `SeedWriter` that writes a seed graph through each entity's own
// repository, so a seed takes the same writes the app makes — Postgres through a pinned client, or
// the driver the app reads through (memory, `testDriver()`). It reads rows back too, as digests by
// primary key: the tenant proof's write half (`snapshot`).
//
// `@ultimat3/entity` loads on the first write, never on import: this module is on the barrel, and
// the barrel stays entity-free.

import { fingerprint } from '@ultimat3/core';
import type { DbClient, SqlFragment } from '@ultimat3/db';
import { identifier, join, sql } from '@ultimat3/db';
import type { Driver, EntityCore, Repo } from '@ultimat3/entity';
import { SeedGraphEntityUnknownError } from './seed-graph-error';
import type { SeedRow, SeedUpdate, SeedWriter } from './seed-graph-plan';

type SeedRepo = Repo<Record<string, unknown>>;

/**
 * One row's digest: core's `fingerprint`, over `canonicalJson` — the framework's one INJECTIVE
 * form: keys sorted, and a date, bytes and a bigint each tagged. A private copy rendered bytes as
 * bare hex, one digest with the text holding that hex — a hash form must never fold two values
 * onto one string, and a second hasher is where the next copy drifts.
 */
export const digestRow = (row: unknown): string => fingerprint(row);

/** The physical columns of an entity's primary key, in key order. */
const keyColumns = (entity: EntityCore): readonly string[] => {
  const columns = entity.$describe().columns;
  return entity.$primaryKey.map(
    (property) => columns.find((column) => column.property === property)?.column ?? property,
  );
};

/** Joins a composite key's parts, in Postgres and here alike: no seeded key holds a unit separator. */
const KEY_SEPARATOR = '\u001f';

/**
 * `md5(t::text)` per row, by primary key, through the client — the whole stored row, columns no
 * entity declares included. ONE statement, a `union all` branch per table, a composite key matched
 * through parallel arrays: the tenant proof snapshots four times a primitive, and a statement per
 * table was primitives × tables round trips. Unscoped on purpose: the question is whether the row
 * changed, not who may read it.
 */
async function snapshotOnClient(
  client: DbClient,
  rows: readonly SeedRow[],
  entities: readonly EntityCore[],
): Promise<readonly (string | null)[]> {
  const byEntity = new Map<EntityCore, number[]>();
  entities.forEach((entity, i) => {
    const indexes = byEntity.get(entity);
    if (indexes === undefined) byEntity.set(entity, [i]);
    else indexes.push(i);
  });
  const keyOf = (entity: EntityCore, i: number): string =>
    entity.$primaryKey.map((property) => String(rows[i]?.row[property])).join(KEY_SEPARATOR);
  const branches = [...byEntity].map(([entity, indexes], at): SqlFragment => {
    const columns = keyColumns(entity).map((column) => identifier(column));
    // Each key column against its values, the parameter UNTYPED so Postgres types it as the
    // column: `id::text = any(…)` read every row of a table that grows with the primitives. A
    // composite key matches a superset here; the full key is matched below.
    const matched = entity.$primaryKey.map(
      (property, part) =>
        sql`${columns[part] as SqlFragment} = any(${[...new Set(indexes.map((i) => String(rows[i]?.row[property])))]})`,
    );
    const texts = columns.map((column) => sql`${column}::text`);
    return sql`select ${at}::int as e, concat_ws(${KEY_SEPARATOR}, ${join(texts)}) as k, md5(t::text) as h from ${identifier(entity.$table)} t where ${join(matched, ' and ')}`;
  });
  if (branches.length === 0) return [];
  const found = await client.query<{ e: number; k: string; h: string }>(
    join(branches, ' union all '),
  );
  const digests = new Map(found.map((one) => [`${one.e}${KEY_SEPARATOR}${one.k}`, one.h]));
  const out: (string | null)[] = rows.map(() => null);
  [...byEntity].forEach(([entity, indexes], at) => {
    for (const i of indexes) {
      out[i] = digests.get(`${at}${KEY_SEPARATOR}${keyOf(entity, i)}`) ?? null;
    }
  });
  return out;
}

/** Where the rows go. One or the other, never both: two answers to one question is a compile error. */
export type SeedWriterTarget =
  /** Postgres (or PGlite) through this client: `postgresRepo(entity, { client })`. */
  | { readonly client: DbClient; readonly driver?: never }
  /** This driver's repositories. Left out: `defaultDriver()`, the one `database()` names by default. */
  | { readonly driver?: Driver; readonly client?: never };

export type EntitySeedWriterOptions = SeedWriterTarget & {
  /** The set the plan came from — the same object handed to `seedGraph`. Keyed by anything. */
  readonly entities: Readonly<Record<string, EntityCore>>;
  /**
   * The `orgId` a write runs under. Default: the row's seeded tenant on a tenant-scoped entity, and
   * none on a tenantless one (a tenant root such as `orgs` carries its tenant but no tenant column).
   */
  readonly tenantOf?: (write: SeedRow | SeedUpdate) => string | undefined;
};

export function entitySeedWriter(options: EntitySeedWriterOptions): SeedWriter {
  const byName = new Map(Object.values(options.entities).map((one) => [one.$name, one]));
  const repos = new Map<string, SeedRepo>();
  let resolve: Promise<(entity: EntityCore) => SeedRepo> | undefined;

  const resolver = async (): Promise<(entity: EntityCore) => SeedRepo> => {
    const { defaultDriver, postgresRepo } = await import('@ultimat3/entity');
    const { client } = options;
    if (client !== undefined) {
      return (entity) => postgresRepo(entity as EntityCore<Record<string, unknown>>, { client });
    }
    const driver = options.driver ?? defaultDriver();
    return (entity) => driver.repo(entity as EntityCore<Record<string, unknown>>);
  };

  const repoFor = async (name: string): Promise<{ entity: EntityCore; repo: SeedRepo }> => {
    const entity = byName.get(name);
    if (entity === undefined) {
      throw new SeedGraphEntityUnknownError({ entity: name, known: [...byName.keys()].sort() });
    }
    resolve ??= resolver();
    const make = await resolve;
    let repo = repos.get(name);
    if (repo === undefined) {
      repo = make(entity);
      repos.set(name, repo);
    }
    return { entity, repo };
  };

  const scope = (entity: EntityCore, write: SeedRow | SeedUpdate): { orgId?: string } => {
    const orgId =
      options.tenantOf !== undefined
        ? options.tenantOf(write)
        : entity.$tenantColumn === null
          ? undefined
          : (write.tenant ?? undefined);
    return orgId === undefined ? {} : { orgId };
  };

  return {
    async insert(row) {
      const { entity, repo } = await repoFor(row.entity);
      await repo.insert({ ...row.row }, scope(entity, row));
    },
    async insertMany(rows) {
      const [first] = rows;
      if (first === undefined) return;
      const { entity, repo } = await repoFor(first.entity);
      // One scope when every row shares it. An insert's statement reads none — both drivers check
      // a row's tenant column against the ACTOR, and a seed has none — so a table holding many
      // tenants' rows is still one `insertAll`.
      const scopes = new Set(rows.map((row) => scope(entity, row).orgId));
      const [only] = scopes;
      await repo.insertAll(
        rows.map((row) => ({ ...row.row })),
        scopes.size === 1 && only !== undefined ? { orgId: only } : {},
      );
    },
    async update(update) {
      const { entity, repo } = await repoFor(update.entity);
      await repo.updateWhere({ ...update.key }, { ...update.patch }, scope(entity, update));
    },
    async snapshot(rows) {
      const entities = await Promise.all(
        rows.map(async (row) => (await repoFor(row.entity)).entity),
      );
      // Postgres hashes the whole stored row (`md5(t::text)`), columns no entity declares included.
      if (options.client !== undefined) return snapshotOnClient(options.client, rows, entities);
      return Promise.all(
        rows.map(async (row, i) => {
          const entity = entities[i] as EntityCore;
          const { repo } = await repoFor(row.entity);
          const where = entity.$primaryKey.map((property) => ({
            column: property,
            op: 'eq' as const,
            value: row.row[property],
          }));
          const page = await repo.findMany({
            where,
            limit: 1,
            includeDeleted: true,
            ...scope(entity, row),
          });
          const found = page.rows[0];
          return found === undefined ? null : digestRow(found);
        }),
      );
    },
  };
}
