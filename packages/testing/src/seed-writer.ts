// `entitySeedWriter`: the `SeedWriter` that writes a seed graph through each entity's own
// repository, so a seed takes the same writes the app makes — Postgres through a pinned client, or
// the driver the app reads through (memory, `testDriver()`). It reads rows back too, as digests by
// primary key: the tenant proof's write half (`snapshot`).
//
// `@ultimat3/entity` loads on the first write, never on import: this module is on the barrel, and
// the barrel stays entity-free.

import type { DbClient, SqlFragment } from '@ultimat3/db';
import { identifier, join, sql } from '@ultimat3/db';
import type { Driver, EntityCore, Repo } from '@ultimat3/entity';
import { SeedGraphEntityUnknownError } from './seed-graph-error';
import type { SeedRow, SeedUpdate, SeedWriter } from './seed-graph-plan';

type SeedRepo = Repo<Record<string, unknown>>;

/** Stable text for one row: keys sorted, an instant as ISO, bytes as hex — never insertion order. */
const stable = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, stable(record[key])]),
  );
};

const digestRow = (row: unknown): string =>
  new Bun.CryptoHasher('md5').update(JSON.stringify(stable(row))).digest('hex');

/** The physical columns of an entity's primary key, in key order. */
const keyColumns = (entity: EntityCore): readonly string[] => {
  const columns = entity.$describe().columns;
  return entity.$primaryKey.map(
    (property) => columns.find((column) => column.property === property)?.column ?? property,
  );
};

/**
 * `md5(t::text)` per row, by primary key, through the client — the whole stored row, columns no
 * entity declares included. One statement per table for a one-column key, one per row for a
 * composite one. Unscoped on purpose: the question is whether the row changed, not who may read it.
 */
async function snapshotOnClient(
  client: DbClient,
  rows: readonly SeedRow[],
  entities: readonly EntityCore[],
): Promise<readonly (string | null)[]> {
  const out: (string | null)[] = rows.map(() => null);
  const byEntity = new Map<EntityCore, number[]>();
  entities.forEach((entity, i) => {
    byEntity.set(entity, [...(byEntity.get(entity) ?? []), i]);
  });
  for (const [entity, indexes] of byEntity) {
    const table = identifier(entity.$table);
    const columns = keyColumns(entity);
    const keyAt = (i: number, at: number) => String(rows[i]?.row[entity.$primaryKey[at] as string]);
    const [single] = columns;
    if (columns.length === 1 && single !== undefined) {
      const key = identifier(single);
      const found = await client.query<{ k: string; h: string }>(
        sql`select ${key}::text as k, md5(t::text) as h from ${table} t where ${key}::text = any(${indexes.map((i) => keyAt(i, 0))}::text[])`,
      );
      const digests = new Map(found.map((one) => [one.k, one.h]));
      for (const i of indexes) out[i] = digests.get(keyAt(i, 0)) ?? null;
      continue;
    }
    for (const i of indexes) {
      const terms: SqlFragment[] = columns.map(
        (column, at) => sql`${identifier(column)}::text = ${keyAt(i, at)}`,
      );
      const one = await client.one<{ h: string }>(
        sql`select md5(t::text) as h from ${table} t where ${join(terms, ' and ')}`,
      );
      out[i] = one?.h ?? null;
    }
  }
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
