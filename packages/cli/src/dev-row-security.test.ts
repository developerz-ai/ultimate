// `x dev` on PGlite with `database.rowSecurity`: the migrate path owns the tables as `x_migrator`,
// the boot serves as `x_app`, and a raw read under tenant A sees A's row alone — B's is refused by
// the database, not the repository. Off, the same app boots as PGlite's superuser and sees both.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { ctxOf, resetLifecycle, runWithContext, userActor } from '@ultimat3/core';
import { db, enableRowSecuritySql, sql } from '@ultimat3/db';
import { startDev } from './cmd-dev';
import { resetRegistries } from './cmd-dev-fixture';
import { runMigrations } from './serve';

const BOOT_TIMEOUT_MS = 90_000;
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const roots: string[] = [];

const MIGRATION = [
  'create table posts (id int primary key, org_id uuid not null);',
  ...enableRowSecuritySql('posts', 'org_id', 'uuid'),
  `insert into posts values (1, '${A}'), (2, '${B}');`,
].join('\n');

async function appRoot(rowSecurity: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'x-dev-rls-'));
  roots.push(root);
  await Bun.write(
    join(root, 'app.config.ts'),
    `export const config = { name: 'fixture', database: { rowSecurity: ${rowSecurity} } };\n`,
  );
  await Bun.write(join(root, 'package.json'), '{"name":"dev-rls","version":"1.0.0"}');
  await Bun.write(join(root, 'packages/db/migrations/0000_posts.sql'), MIGRATION);
  return root;
}

const count = async (): Promise<number> =>
  (await db().one<{ n: number }>(sql`select count(*)::int as n from posts`))?.n ?? -1;
const asTenantA = <T>(run: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'u1', orgId: A }) }), run);
const owner = async (): Promise<string | undefined> =>
  (
    await db().one<{ owner: string }>(
      sql`select pg_get_userbyid(relowner) as owner from pg_class where relname = 'posts'`,
    )
  )?.owner;

afterEach(() => {
  resetRegistries();
  resetLifecycle();
});
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe('x dev · row security on PGlite', () => {
  test(
    'on: migrated as x_migrator, served as x_app, tenant A sees 1 of 2 and no tenant sees 0',
    async () => {
      const root = await appRoot(true);
      await runMigrations({ root, env: {} });
      const server = await startDev({ root, port: 0, env: {}, roles: ['web'] });
      try {
        expect(await owner()).toBe('x_migrator');
        expect(await asTenantA(count)).toBe(1);
        expect(await count()).toBe(0);
        const role = await db().one<{ role: string }>(sql`select current_user as role`);
        expect(role?.role).toBe('x_app');
      } finally {
        await server.stop();
      }
    },
    BOOT_TIMEOUT_MS,
  );

  test(
    'off: nothing changes — the superuser owns the table and reads both rows',
    async () => {
      const root = await appRoot(false);
      await runMigrations({ root, env: {} });
      const server = await startDev({ root, port: 0, env: {}, roles: ['web'] });
      try {
        expect(await owner()).not.toBe('x_migrator');
        expect(await asTenantA(count)).toBe(2);
        const role = await db().one<{ role: string }>(sql`select current_user as role`);
        expect(role?.role).not.toBe('x_app');
      } finally {
        await server.stop();
      }
    },
    BOOT_TIMEOUT_MS,
  );
});
