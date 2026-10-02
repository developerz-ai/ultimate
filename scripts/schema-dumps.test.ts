// `bun run schema-dumps`: one finding per stale app naming the one command, every app visited,
// and a replay failure carried through as itself. The two verbs are injected — what they do
// against a database is `@ultimat3/cli`'s own tests'.

import { describe, expect, test } from 'bun:test';
import { GATED_APPS } from './lib/gated-apps';
import type { Finding } from './lib/log';
import { checkDumps, type DumpVerbs, staleDump, writeDumps } from './schema-dumps';

const difference = (path: string): Finding => ({
  code: 'X_SCHEMA_DUMP_DRIFT',
  cause: `schema dump file ${path} differs from what the migrations produce`,
  fix: 'x db gen',
  at: `packages/db/schema/${path}`,
});

const verbs = (over: Partial<DumpVerbs>): DumpVerbs => ({
  check: async () => [],
  refresh: async () => ({ written: [], removed: [] }),
  ...over,
});

describe('checkDumps', () => {
  test('a clean tree: every app visited, no finding', async () => {
    const seen: string[] = [];
    const dumps = await checkDumps(
      '/repo',
      ['examples/a', 'examples/b'],
      verbs({
        check: async (root) => {
          seen.push(root);
          return [];
        },
      }),
    );
    expect(seen).toEqual(['/repo/examples/a', '/repo/examples/b']);
    expect(dumps.flatMap((dump) => dump.findings)).toEqual([]);
  });

  test('a stale app is ONE finding naming the app and the command, however many files moved', async () => {
    const dumps = await checkDumps(
      '/repo',
      ['examples/a', 'examples/b'],
      verbs({
        check: async (root) =>
          root.endsWith('/a')
            ? [
                difference('framework/04_tables/x_jobs.sql'),
                difference('framework/05_indexes/x_jobs.sql'),
              ]
            : [],
      }),
    );
    expect(dumps[0]?.findings).toEqual([
      {
        code: 'X_SCHEMA_DUMP_DRIFT',
        cause:
          "examples/a/packages/db/schema is not what its migrations and the framework's tables produce — 2 difference(s), the first: schema dump file framework/04_tables/x_jobs.sql differs from what the migrations produce",
        fix: "bun run schema-dumps   # regenerates every tracked app's dump; commit what it writes",
        at: 'examples/a',
      },
    ]);
    expect(dumps[0]?.changed).toHaveLength(2);
    // The second app is still checked: the fix is one command for all of them.
    expect(dumps[1]).toEqual({ app: 'examples/b', changed: [], findings: [] });
  });

  test('every stale app is reported, not only the first', async () => {
    const dumps = await checkDumps(
      '/repo',
      ['examples/a', 'examples/b'],
      verbs({ check: async () => [difference('04_tables/posts.sql')] }),
    );
    expect(dumps.map((dump) => dump.findings[0]?.at)).toEqual(['examples/a', 'examples/b']);
  });
});

describe('writeDumps', () => {
  test('reports what each app wrote and deleted', async () => {
    const dumps = await writeDumps(
      '/repo',
      ['examples/a'],
      verbs({
        refresh: async () => ({
          written: ['packages/db/schema/framework/04_tables/x_jobs.sql'],
          removed: ['packages/db/schema/framework/04_tables/x_old.sql'],
        }),
      }),
    );
    expect(dumps).toEqual([
      {
        app: 'examples/a',
        changed: [
          'packages/db/schema/framework/04_tables/x_jobs.sql',
          '- packages/db/schema/framework/04_tables/x_old.sql',
        ],
        findings: [],
      },
    ]);
  });

  test('a replay that fails is the app’s own finding, with the app named — not staleness', async () => {
    const failure: Finding = {
      code: 'X_SCHEMA_DUMP_DRIFT',
      cause: 'the migrations do not replay on the scratch database',
      fix: 'x db migrate --json',
      at: 'packages/db/migrations',
    };
    const dumps = await writeDumps(
      '/repo',
      ['examples/a', 'examples/b'],
      verbs({
        refresh: async (root) => ({
          written: [],
          removed: [],
          finding: root.endsWith('/a') ? failure : undefined,
        }),
      }),
    );
    expect(dumps[0]?.findings).toEqual([{ ...failure, at: 'examples/a' }]);
    expect(dumps[1]?.findings).toEqual([]);
  });
});

describe('staleDump', () => {
  test('never restates the app list: the script reads GATED_APPS', () => {
    // The apps a real run visits are the gate's own, so a third tracked app is covered the day it
    // is added there.
    expect(GATED_APPS.length).toBeGreaterThan(0);
    expect(staleDump('x', []).cause).toContain('0 difference(s)');
  });
});
