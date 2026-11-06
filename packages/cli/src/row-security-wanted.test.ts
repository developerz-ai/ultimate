// The gate's `drift` step on `database.rowSecurity`: a flipped flag moves no entity and no source
// hash, so this is the only reader that sees it. Real sidecars on disk, as `schema-drift.test.ts`.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import type { EntityDescriptionLike, RowSecurityOption, SchemaDescription } from '@ultimat3/db';
import { snapshotOf } from '@ultimat3/db';
import { MIGRATIONS_DIR, snapshotFileName } from './migrations';
import { checkSnapshotDrift } from './schema-drift';

const col = (column: string, primaryKey = false) => ({
  property: column,
  column,
  kind: 'uuid',
  notNull: true,
  primaryKey,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
});
const posts: EntityDescriptionLike = {
  name: 'posts',
  table: 'posts',
  primaryKey: ['id'],
  columns: [col('id', true), col('org_id')],
  indexes: [],
};
const tenants = [{ table: 'posts', column: 'org_id' }];

async function drift(snapshot: SchemaDescription, option: RowSecurityOption) {
  const root = mkdtempSync(join(tmpdir(), 'x-row-security-drift-'));
  try {
    await Bun.write(join(root, 'packages', 'db', 'src', 'schema.ts'), 'export {};\n');
    await Bun.write(join(root, MIGRATIONS_DIR, '20261106000000_init.sql'), '-- init\n');
    await Bun.write(
      join(root, MIGRATIONS_DIR, snapshotFileName('20261106000000_init')),
      `${JSON.stringify(snapshot)}\n`,
    );
    return await checkSnapshotDrift(
      root,
      async () => [posts],
      () => [],
      async () => option,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('drift · database.rowSecurity', () => {
  test('flag on, no migration gave the tenant table its policy: X_DB_ROW_SECURITY_DRIFT', async () => {
    const findings = await drift(snapshotOf([posts]), { enabled: true, tenants });
    expect(findings).toEqual([
      expect.objectContaining({
        code: 'X_DB_ROW_SECURITY_DRIFT',
        fix: 'x db gen "row security"',
        at: MIGRATIONS_DIR,
      }),
    ]);
  });

  test('flag on and recorded is clean; flag off and recorded is drift the other way', async () => {
    const recorded = snapshotOf([posts], new Set(), new Set(['posts']));
    expect(await drift(recorded, { enabled: true, tenants })).toEqual([]);
    const [stray] = await drift(recorded, { enabled: false, tenants });
    expect(stray?.code).toBe('X_DB_ROW_SECURITY_DRIFT');
    expect(stray?.cause).toContain('is off');
  });
});
