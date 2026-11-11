// `@ultimat3/auth/schema` is the auth DDL the boot applies and nothing else: a LEAF, so every role
// that reads the framework schema (`ROLE=migrate` first) loads table names and SQL, never the barrel.

import { describe, expect, test } from 'bun:test';
import * as barrel from './index';
import * as leaf from './tables';

const manifest: unknown = await Bun.file(new URL('../package.json', import.meta.url)).json();

/** Every module `entry` reaches by static import, as paths relative to this directory. */
async function reached(entry: string): Promise<readonly string[]> {
  const transpiler = new Bun.Transpiler({ loader: 'ts' });
  const seen = new Set<string>([entry]);
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() ?? '';
    const source = await Bun.file(new URL(file, import.meta.url)).text();
    for (const edge of transpiler.scanImports(source)) {
      const next = edge.path.startsWith('./') ? `${edge.path}.ts` : edge.path;
      if (seen.has(next)) continue;
      seen.add(next);
      if (next.startsWith('./')) stack.push(next);
    }
  }
  return [...seen].sort();
}

const NAMES = [
  'AUTH_SERVER_TABLES',
  'AUTH_TABLES',
  'AUTH_TABLE_NAMES',
  'SQL_AUTH_LIMIT_TABLES',
  'SQL_AUTH_SERVER_TABLES',
  'SQL_TOTP_REPLAY_TABLE',
];

describe('@ultimat3/auth/schema', () => {
  test('package.json maps ./schema to the leaf', () => {
    expect(manifest).toMatchObject({ exports: { './schema': './src/tables.ts' } });
  });

  test('carries every auth table the boot applies, and nothing else', () => {
    // A per-table constant here would be public API again (they were removed in 22.0.0).
    expect(Object.keys(leaf).sort()).toEqual(NAMES);
  });

  test('imports nothing but its sibling DDL — no runtime, no other package', async () => {
    expect(await reached('./tables.ts')).toEqual([
      './authorization-server-schema.ts',
      './tables.ts',
    ]);
  });

  test('the barrel re-exports the same values, so `.` and `./schema` cannot drift', () => {
    const fromBarrel: Readonly<Record<string, unknown>> = barrel;
    const fromLeaf: Readonly<Record<string, unknown>> = leaf;
    for (const name of NAMES) expect([name, fromBarrel[name]]).toEqual([name, fromLeaf[name]]);
  });
});
