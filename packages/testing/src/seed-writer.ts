// `entitySeedWriter`: the `SeedWriter` that writes a seed graph through each entity's own
// repository, so a seed takes the same writes the app makes — Postgres through a pinned client, or
// the driver the app reads through (memory, `testDriver()`). `@ultimat3/entity` loads on the first
// write, never on import: this module is on the barrel, and the barrel stays entity-free.

import type { DbClient } from '@ultimat3/db';
import type { Driver, EntityCore, Repo } from '@ultimat3/entity';
import { SeedGraphEntityUnknownError } from './seed-graph-error';
import type { SeedRow, SeedUpdate, SeedWriter } from './seed-graph-plan';

type SeedRepo = Repo<Record<string, unknown>>;

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
  };
}
