// The tenant proof's planted-hole app on the memory driver: one tenant-columned parent, a child
// that reaches it by foreign key and carries no tenant, the actors, and `proveOne` — one exercise
// pass over one primitive, seeded through `entitySeedWriter`. A fixture, so it never ships.

import { expect } from 'bun:test';
import type { EntityCore } from '@ultimat3/entity';
import { entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import type { NamedActor } from '@ultimat3/policy';
import { testActor } from '@ultimat3/policy';
import { runExercisePass } from './exercise';
import type { ExerciseRecord } from './exercise-report';
import type { SeedEntity } from './seed-graph-shape';
import { entitySeedWriter } from './seed-writer';

export const tpOrgs = entity('tp_orgs', {
  columns: { id: uuid().primaryKey(), name: text({ max: 40 }) },
});

/** Tenant-columned: the repository guard scopes every read and write of it to the actor's org. */
export const tpVaults = entity('tp_vaults', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => tpOrgs.id)
      .tenant(),
    label: text({ max: 80 }),
  },
});

/**
 * The planted hole of slice 40's probe: a child of a tenant-owned table with no tenant column. NO
 * `shared:` on purpose — the brief asked for one so the static check would not preempt it, but the
 * static check is `x exercise`'s CLI half, not `runExercisePass`, and `seedGraph` reads `shared` as
 * "this row belongs to no tenant" (`seed-graph.ts`, `ownedByTenant`): declared, A would own no row
 * of it and the hole would read as a shared table. Undeclared it is seeded per tenant, as the probe.
 */
export const tpFiles = entity('tp_files', {
  columns: {
    id: uuid().primaryKey(),
    vaultId: uuid().references(() => tpVaults.id),
    url: text({ max: 120 }),
    owner: text({ max: 60 }),
  },
});

/** A child DECLARED shared: its rows are nobody's, so reading one by id is no tenant's leak. */
export const tpLinks = entity('tp_links', {
  shared: 'a public share link: readable by anyone holding it, owned by no tenant',
  columns: {
    id: uuid().primaryKey(),
    vaultId: uuid().references(() => tpVaults.id),
    slug: text({ max: 80 }),
  },
});

export const TP_ENTITIES = { tpOrgs, tpVaults, tpFiles, tpLinks } as const;

/** One driver for the whole file; `resetTenantApp` empties it so no pass reads another's rows. */
export const tpDriver = memoryDriver();

/** The hand-built cache the cache hole keys by id alone. Emptied with the driver. */
export const tpLabelCache = new Map<string, string>();

export const resetTenantApp = (): void => {
  tpDriver.reset?.();
  tpLabelCache.clear();
};

export const TP_PERMISSIONS = ['tp:read', 'tp:write'] as const;

/** What `x exercise` would hand in from `devActors()`: anonymous, and one member per tenant. */
export const tpRoles = (tenant: string): readonly NamedActor[] => [
  { name: 'anonymous', actor: null },
  testActor('member', { permissions: [...TP_PERMISSIONS], orgId: tenant }),
];

/** The pass over exactly one primitive, its rows written through the entities' own repositories. */
export async function proveOne(
  only: string,
  entities: Readonly<Record<string, SeedEntity & EntityCore>> = TP_ENTITIES,
): Promise<ExerciseRecord> {
  const records = await runExercisePass({
    entities: Object.values(entities),
    writer: entitySeedWriter({ entities, driver: tpDriver }),
    roles: tpRoles,
    only,
    seed: 40,
  });
  expect(records).toHaveLength(1);
  return records[0] as ExerciseRecord;
}

/** Every stored row of a tenantless table: no `orgId` to scope, so one unscoped page. */
export async function tenantlessRows(
  target: typeof tpFiles,
): Promise<readonly Record<string, unknown>[]> {
  const page = await tpDriver.repo(target).findMany({ limit: 100 });
  return page.rows as readonly Record<string, unknown>[];
}
