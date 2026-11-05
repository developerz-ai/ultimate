// The seed graph against Postgres, over both tracked apps' own entities and their own migrations:
// with no factory written, every generated row inserts — every foreign key, CHECK, unique key and
// same-tenant composite key the real schema declares accepts it. Skips unless `TEST_DATABASE_URL`.

import { afterAll, describe, expect, test } from 'bun:test';
import { probeDatabaseName } from '@ultimat3/core';
import { type Migration, migrate, type PostgresClient, postgresClient, raw } from '@ultimat3/db';
import { type EntityCore, postgresRepo } from '@ultimat3/entity';
import { isolateEntityRegistry } from './registry-isolation';
import { seedGraph } from './seed-graph';
import { insertSeedGraph } from './seed-graph-plan';
import type { SeedEntity } from './seed-graph-shape';
import { urlFor } from './template-db';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';
const REPO = `${import.meta.dir}/../../..`;
const APPS = [
  { name: 'dummy', root: `${REPO}/examples/dummy` },
  { name: 'social', root: `${REPO}/dummy/social-media-clone` },
] as const;

/** An `entity()` value among a module's exports: the one export shape with both projections. */
const isEntity = (value: unknown): value is SeedEntity & EntityCore<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  '$describe' in value &&
  typeof value.$describe === 'function' &&
  '$references' in value;

/**
 * Each app's schema modules, imported with the entity registry emptied: both apps declare `posts`,
 * and a second registration of one name is `X_ENTITY_DUPLICATE`. The values outlive the registry.
 */
const entitiesOf = async (
  root: string,
): Promise<Record<string, SeedEntity & EntityCore<unknown>>> => {
  const restore = isolateEntityRegistry();
  try {
    const found: Record<string, SeedEntity & EntityCore<unknown>> = {};
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
const migrationsOf = async (root: string): Promise<readonly Migration[]> => {
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

describe.skipIf(adminUrl === '')('live · seedGraph over both tracked apps', () => {
  const admin = adminUrl === '' ? undefined : postgresClient({ url: adminUrl });
  const opened: PostgresClient[] = [];
  const created: string[] = [];

  afterAll(async () => {
    for (const client of opened) await client.close();
    for (const name of created) {
      await admin?.execute(raw(`drop database if exists "${name}" with (force)`));
    }
    await admin?.close();
  });

  for (const app of APPS) {
    test(`${app.name}: every generated row inserts, with no factory`, async () => {
      const database = probeDatabaseName(`seed_graph_${app.name}`);
      created.push(database);
      await admin?.execute(raw(`create database "${database}"`));
      const client = postgresClient({ url: urlFor(adminUrl, database) });
      opened.push(client);
      await migrate({ migrations: await migrationsOf(app.root), client, lock: false });

      const entities = await entitiesOf(app.root);
      const graph = seedGraph(entities, { tenants: 2, perTable: 3, seed: 11 });
      const repo = (name: string) =>
        postgresRepo(entities[name] as EntityCore<unknown>, { client });
      await insertSeedGraph(graph, {
        insert: async ({ entity, row }) => {
          await repo(entity).insert(row as never);
        },
        update: async ({ entity, key, patch, tenant }) => {
          await repo(entity).updateWhere(
            key as never,
            patch as never,
            tenant === null ? {} : { orgId: tenant },
          );
        },
      });

      expect(Object.keys(entities).length).toBeGreaterThan(5);
      for (const [name, entity] of Object.entries(entities)) {
        const expected = graph.inserts.filter((row) => row.entity === name).length;
        expect(expected).toBeGreaterThan(0);
        const counted = await client.one<{ n: number }>(
          raw(`select count(*)::int as n from "${entity.$table}"`),
        );
        expect({ name, n: counted?.n }).toEqual({ name, n: expected });
      }
    }, 60_000);
  }
});
