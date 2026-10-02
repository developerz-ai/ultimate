// The schema-dump family is its own entry. `@ultimat3/db` is imported by every role of every app,
// and ten modules only `x db gen`, `x db migrate` and the gate's `drift` step call rode its barrel
// into each one. Proved in a child process: this test process has loaded them through other files.

import { describe, expect, test } from 'bun:test';
import * as barrel from './index';
import * as entry from './schema-dump-entry';

/** The files behind `@ultimat3/db/schema-dump`: nothing the barrel evaluates may be one of them. */
const FAMILY =
  /\/db\/src\/(?:catalog(?:-fold|-objects|-relations)?|dump-drift|introspect-catalog|object-drift|schema-dump(?:-table|-entry)?|schema-load)\.ts$/;

const PROBE = `
const family = new RegExp(${JSON.stringify(FAMILY.source)});
const loaded = () => Object.keys(require.cache).filter((key) => family.test(key)).length;
await import(${JSON.stringify(`${import.meta.dir}/index.ts`)});
const barrel = loaded();
await import(${JSON.stringify(`${import.meta.dir}/schema-dump-entry.ts`)});
console.log(JSON.stringify({ barrel, entry: loaded() }));
`;

describe('unit · @ultimat3/db/schema-dump', () => {
  test('importing @ultimat3/db evaluates none of the family; the subpath evaluates all ten', async () => {
    const child = Bun.spawn(['bun', '-e', PROBE], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect([await child.exited, err]).toEqual([0, '']);
    // Eleven with the entry itself.
    expect(JSON.parse(out.trim().split('\n').at(-1) ?? '{}')).toEqual({ barrel: 0, entry: 11 });
  }, 30_000);

  test('every name has one home: the subpath exports them and the barrel none', () => {
    const moved = [
      'compareSchemaDump',
      'emptyCatalog',
      'introspectCatalog',
      'loadSchemaDump',
      'reloadDifferences',
      'renderSchemaDump',
      'schemaDumpDifferenceOf',
      'schemaDumpDrift',
      'unexpectedObjects',
    ];
    expect(Object.keys(entry).sort()).toEqual(moved);
    expect(moved.filter((name) => name in barrel)).toEqual([]);
  });
});
