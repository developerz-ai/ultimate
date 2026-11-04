// The diagnostics family is its own entry. `@ultimat3/db` is imported by every role of every app,
// and only `x db diagnostics` calls these five modules. Proved in a child process: this test
// process may have loaded them through other files.

import { describe, expect, test } from 'bun:test';
import * as entry from './diagnostics-entry';
import * as barrel from './index';

/** The files behind `@ultimat3/db/diagnostics`: nothing the barrel evaluates may be one of them. */
const FAMILY =
  /\/db\/src\/(?:db-diagnostics(?:-deadline|-redact|-rows|-sql)?|diagnostics-entry)\.ts$/;

const PROBE = `
const family = new RegExp(${JSON.stringify(FAMILY.source)});
const loaded = () => Object.keys(require.cache).filter((key) => family.test(key)).length;
await import(${JSON.stringify(`${import.meta.dir}/index.ts`)});
const barrel = loaded();
await import(${JSON.stringify(`${import.meta.dir}/diagnostics-entry.ts`)});
console.log(JSON.stringify({ barrel, entry: loaded() }));
`;

describe('unit · @ultimat3/db/diagnostics', () => {
  test('importing @ultimat3/db evaluates none of the family; the subpath evaluates it', async () => {
    const child = Bun.spawn(['bun', '-e', PROBE], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect([await child.exited, err]).toEqual([0, '']);
    // `db-diagnostics-rows.ts` holds types only and is erased; four modules plus the entry.
    const counts = JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as {
      barrel: number;
      entry: number;
    };
    expect(counts.barrel).toBe(0);
    expect(counts.entry).toBeGreaterThanOrEqual(5);
  }, 30_000);

  test('every name has one home: the subpath exports them and the barrel none', () => {
    const moved = ['DIAGNOSTICS_LIMIT', 'DIAGNOSTICS_TIMEOUT_MS', 'dbDiagnostics'];
    expect(Object.keys(entry).sort()).toEqual(moved);
    expect(moved.filter((name) => name in barrel)).toEqual([]);
  });
});
