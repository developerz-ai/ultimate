// Both tracked apps as a seed graph's proof reads them: their own `entity()` values and their own
// migrations, loaded the way `x db migrate` loads them. Shared by the Postgres, PGlite and memory
// proofs so the three agree on the input; a fixture, so it never ships (`!src/**/*-fixture.ts`).

import { type DbClient, type Migration, migrate, raw } from '@ultimat3/db';
import type { EntityCore } from '@ultimat3/entity';
import { isolateEntityRegistry } from './registry-isolation';
import { seedGraph } from './seed-graph';
import { insertSeedGraph } from './seed-graph-plan';
import type { SeedEntity } from './seed-graph-shape';
import { entitySeedWriter } from './seed-writer';

const REPO = `${import.meta.dir}/../../..`;

export const TRACKED_APPS = [
  { name: 'dummy', root: `${REPO}/examples/dummy` },
  { name: 'social', root: `${REPO}/dummy/social-media-clone` },
] as const;

export type AppEntity = SeedEntity & EntityCore;

/** An `entity()` value among a module's exports: the one export shape with both projections. */
const isEntity = (value: unknown): value is AppEntity =>
  typeof value === 'object' &&
  value !== null &&
  '$describe' in value &&
  typeof value.$describe === 'function' &&
  '$references' in value;

/**
 * Each app's schema modules, imported with the entity registry emptied: both apps declare `posts`,
 * and a second registration of one name is `X_ENTITY_DUPLICATE`. The values outlive the registry.
 */
export const entitiesOf = async (root: string): Promise<Record<string, AppEntity>> => {
  const restore = isolateEntityRegistry();
  try {
    const found: Record<string, AppEntity> = {};
    const dir = `${root}/packages/db/src/schema`;
    const files = [...new Bun.Glob('*.ts').scanSync({ cwd: dir })]
      .filter((f) => !f.endsWith('.test.ts'))
      .sort();
    for (const file of files) {
      const module: Record<string, unknown> = await import(`${dir}/${file}`);
      for (const value of Object.values(module)) if (isEntity(value)) found[value.$name] = value;
    }
    return found;
  } finally {
    restore();
  }
};

/** `x db migrate`'s list, read the way `@ultimat3/cli`'s reader does: up is above `-- down`. */
export const migrationsOf = async (root: string): Promise<readonly Migration[]> => {
  const dir = `${root}/packages/db/migrations`;
  const files = [...new Bun.Glob('*.sql').scanSync({ cwd: dir })]
    .filter((f) => !f.endsWith('.down.sql'))
    .sort();
  return Promise.all(
    files.map(async (file) => {
      const text = await Bun.file(`${dir}/${file}`).text();
      const marker = /^[ \t]*--[ \t]*down[ \t]*$/im.exec(text);
      const id = file.replace(/\.sql$/, '');
      return {
        id,
        name: id.replace(/^\d+_/, ''),
        up: (marker === null ? text : text.slice(0, marker.index)).trim(),
        down: marker === null ? '' : text.slice(marker.index + marker[0].length).trim(),
      };
    }),
  );
};

/** Per entity: the rows the plan wrote, and the rows the table holds after — equal when it took them. */
export interface SeededCount {
  readonly name: string;
  readonly planned: number;
  readonly stored: number | undefined;
}

/**
 * Migrates an empty database through `client`, writes one seed graph of the app into it through
 * `entitySeedWriter({ client })`, and counts each table: the one proof Postgres and PGlite share.
 */
export const seedAppThrough = async (
  client: DbClient,
  root: string,
): Promise<readonly SeededCount[]> => {
  await migrate({ migrations: await migrationsOf(root), client, lock: false });
  const entities = await entitiesOf(root);
  const graph = seedGraph(entities, { tenants: 2, perTable: 3, seed: 11 });
  await insertSeedGraph(graph, entitySeedWriter({ entities, client }));
  const counts: SeededCount[] = [];
  // A view or a history table holds no seeded row of its own (`seedGraph` skips both).
  const seeded = Object.values(entities).filter(
    (e) => e.$describe().view === undefined && e.$describe().historyOf === undefined,
  );
  for (const entity of seeded) {
    const row = await client.one<{ n: number }>(
      raw(`select count(*)::int as n from "${entity.$table}"`),
    );
    counts.push({
      name: entity.$name,
      planned: graph.inserts.filter((insert) => insert.entity === entity.$name).length,
      stored: row?.n,
    });
  }
  return counts;
};
