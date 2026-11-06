// The `action → db` edge is ONE file wide. It was given up for two call sites — the cache bust and
// the idempotency settlement both have to know about the open transaction — and a second importer
// is how "the store takes a structural executor" quietly stops being true.

import { describe, expect, test } from 'bun:test';

const SOURCE = new Bun.Glob('*.ts');
const IMPORTS_DB = /from\s+'@ultimat3\/db'/;

describe('the action → db edge', () => {
  test('tx-scope.ts is the only shipped module that imports @ultimat3/db', async () => {
    const importers: string[] = [];
    for await (const file of SOURCE.scan({ cwd: import.meta.dir })) {
      // What ships: `package.json`'s `files` leaves tests and fixtures out of the tarball.
      if (file.endsWith('.test.ts') || file.endsWith('-fixture.ts')) continue;
      if (IMPORTS_DB.test(await Bun.file(`${import.meta.dir}/${file}`).text()))
        importers.push(file);
    }
    expect(importers).toEqual(['tx-scope.ts']);
  });
});

// The cache bust rides `openCommitScope()`, and so does the row observer's report: with no SQL
// transaction, the open MEMORY transaction answers for both, or a rolled-back write busts a cache
// for a row that never existed.
const ROLL_BACK = new TypeError('roll it back');

describe('openCommitScope over the memory store', () => {
  test('a memory COMMIT runs the effect; a memory ROLLBACK drops it', async () => {
    const { memoryTransactor } = await import('@ultimat3/entity');
    const { openCommitScope } = await import('./tx-scope');
    const ran: string[] = [];
    await memoryTransactor().run(async () => {
      openCommitScope()?.onCommit(() => ran.push('committed'));
    });
    const rolledBack = await memoryTransactor()
      .run(async () => {
        openCommitScope()?.onCommit(() => ran.push('rolled back'));
        throw ROLL_BACK;
      })
      .catch((error: unknown) => error);
    expect(rolledBack).toBe(ROLL_BACK);
    expect(ran).toEqual(['committed']);
    expect(openCommitScope()).toBeUndefined();
  });
});
