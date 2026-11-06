// `x db gen` on an app whose `app.config.ts` turns `database.rowSecurity` on: the migration it
// writes carries every tenant table's forced policy, read off the app's own config and entities.

import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { clearRegistry, entity, uuid } from '@ultimat3/entity';
import { generateAppMigration } from './db-generate';

entity('dgrs_posts', { columns: { id: uuid().primaryKey(), orgId: uuid().tenant() } });
entity('dgrs_plans', { shared: 'one price list for all', columns: { id: uuid().primaryKey() } });

afterAll(() => {
  clearRegistry();
});

async function generate(rowSecurity: boolean): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'x-db-gen-rls-'));
  try {
    await Bun.write(join(root, 'packages/db/src/schema.ts'), 'export const schema = 1;\n');
    // A plain object: `loadAppConfig` holds it to `defineConfig` itself.
    await Bun.write(
      join(root, 'app.config.ts'),
      `export const config = { name: 'rls-app', database: { rowSecurity: ${String(rowSecurity)} } };\n`,
    );
    return (await generateAppMigration(root, { name: 'initial' })).migration?.up ?? '';
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('flag on: the tenant table is enabled, forced and given the policy; the shared one is not', async () => {
  const up = await generate(true);
  expect(up).toContain('alter table "dgrs_posts" force row level security;');
  expect(up).toContain('create policy "ultimate_tenant" on "dgrs_posts" using ("org_id" =');
  expect(up).not.toContain('"dgrs_plans" enable row level security');
});

test('flag off: no policy at all', async () => {
  expect(await generate(false)).not.toContain('row level security');
});
