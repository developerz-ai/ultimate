// `x db gen` for a diff that needs a step outside the transaction: an `indexes: [{ concurrently:
// true }]` beside a new column writes TWO migrations — each with its own `.sql`, snapshot and hash —
// and both parse back through the reader `x db migrate` applies them with, the second still marked.

import { afterAll, expect, test } from 'bun:test';
// why: `node:fs`/`node:os` — Bun has no temp-directory API; `node:path` — no Bun path joiner.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { declaredSchema, isNonTransactional } from '@ultimat3/db';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import { generateAppMigration } from './db-generate';
import { readMigrations } from './migrations';

afterAll(() => {
  clearRegistry();
});

test('a new column and a concurrent index are two migrations, applied in that order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'x-db-gen-concurrently-'));
  try {
    clearRegistry();
    entity('db_gen_conc_runs', { columns: { id: uuid().primaryKey(), status: text({ max: 20 }) } });
    const first = await generateAppMigration(dir, { name: 'create runs' });
    expect(first.outcome).toBe('generated');

    clearRegistry();
    entity('db_gen_conc_runs', {
      columns: { id: uuid().primaryKey(), status: text({ max: 20 }), note: text({ max: 20 }) },
      indexes: [{ on: ['status'], concurrently: true }],
    });
    // The test clock is frozen, so both ids share one stamp and sort by name: `create` < `runs`.
    const second = await generateAppMigration(dir, { name: 'runs gain a note' });
    const id = second.migration?.id ?? '';
    const later = `${id}_concurrently`;
    expect(second.migration?.followUp?.id).toBe(later);
    expect(second.files).toEqual([
      `packages/db/migrations/${id}.sql`,
      `packages/db/migrations/${id}.snapshot.json`,
      `packages/db/migrations/${id}.hash`,
      `packages/db/migrations/${later}.sql`,
      `packages/db/migrations/${later}.snapshot.json`,
      `packages/db/migrations/${later}.hash`,
    ]);

    const migrations = await readMigrations(dir);
    expect(migrations.map((each) => each.id)).toEqual([first.migration?.id ?? '', id, later]);
    // The marker survives the header `x db gen` writes and the `-- down` split the reader makes.
    expect(migrations.map((each) => isNonTransactional(each.up))).toEqual([false, false, true]);
    expect(migrations[2]?.up).toContain(
      'create index concurrently if not exists "db_gen_conc_runs_status_idx"',
    );
    expect(migrations[2]?.down).toBe(
      'drop index concurrently if exists "db_gen_conc_runs_status_idx";',
    );
    // The NEWEST snapshot is the next diff's base, and it holds the index.
    expect(declaredSchema(migrations)?.tables[0]?.indexes.map((each) => each.name)).toEqual([
      'db_gen_conc_runs_status_idx',
    ]);

    const third = await generateAppMigration(dir, { name: 'again' });
    expect(third.migration).toBeUndefined();
    expect((await readMigrations(dir)).length).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
