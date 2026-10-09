// The framework's migrated test database, end to end against the real embedded Postgres: the
// framework schema and every app migration are in it, a second open restores the cached template
// instead of migrating again, and a migration change builds a new template and evicts down to the
// newest previous one (#738) — where an app's hand-rolled copy of this kept every one it ever made.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, no directory listing and no recursive remove.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { sql } from '@ultimat3/db';
import { MIGRATIONS_DIR } from './migrations';
import { migratedDatabase } from './test-database';
import { TEST_DB_DIR } from './test-db-template';

// A WASM compile plus an initdb per template, against bun's 5 s default: a hang detector.
const PGLITE_BOOT_MS = 120_000;

const root = mkdtempSync(join(tmpdir(), 'x-test-database-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(join(root, 'app.config.ts'), 'export default {};\n');
mkdirSync(join(root, MIGRATIONS_DIR), { recursive: true });
const migration = (name: string, ddl: string): void =>
  writeFileSync(join(root, MIGRATIONS_DIR, `${name}.sql`), ddl);
const templates = (): readonly string[] =>
  readdirSync(join(root, '.x', TEST_DB_DIR)).filter((name) => name.endsWith('.tar'));

async function tables(from: string): Promise<readonly string[]> {
  const client = await migratedDatabase({ root: from });
  try {
    const rows = await client.query<{ name: string }>(
      sql`select table_name as name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    return rows.map((row) => row.name);
  } finally {
    await client.close();
  }
}

describe('migratedDatabase', () => {
  test(
    'framework schema plus every migration; one template per state, evicted to the newest previous',
    async () => {
      migration('20260101000000_posts', 'create table posts (id serial primary key);');
      const first = await tables(root);
      expect(first).toContain('posts');
      expect(first).toContain('x_jobs');
      expect(templates()).toHaveLength(1);

      // From a source folder below the root: the same template, no `.x` beside the code.
      const nested = join(root, 'apps', 'web', 'app');
      mkdirSync(nested, { recursive: true });
      expect(await tables(nested)).toEqual(first);
      expect(templates()).toHaveLength(1);
      expect(readdirSync(nested)).toEqual([]);

      migration('20260102000000_tags', 'create table tags (id serial primary key);');
      expect(await tables(root)).toContain('tags');
      expect(templates()).toHaveLength(2);

      migration('20260103000000_likes', 'create table likes (id serial primary key);');
      expect(await tables(root)).toContain('likes');
      // Three migration states, two templates: the current one and the newest previous.
      expect(templates()).toHaveLength(2);
    },
    PGLITE_BOOT_MS,
  );
});
