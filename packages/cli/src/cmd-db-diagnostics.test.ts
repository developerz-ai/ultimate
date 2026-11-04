// `x db diagnostics` at the command altitude: the `--json` body against the app's own embedded
// database, the spec row the parser and `x help` read, and `X_DB_LOCK_TIMEOUT`'s fix resolving to
// it. The renderings themselves are `db-diagnostics.test.ts`'s.

import { describe, expect, test } from 'bun:test';
// why: `node:fs` — Bun has no temp-directory API.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { driverError } from '@ultimat3/db';
import { REQUIRED_BUN } from './app-root';
import { DB_SUBCOMMANDS, dbCommand } from './cmd-db';
import { renderHelp } from './cmd-help';
import type { CommandContext } from './command';
import { fixProblem } from './error-contract';
import { exec } from './exec';
import { citedCommandProblem, loadCommandCatalog } from './fix-command';
import { renderJson } from './output';
import { flagString, parseArgs } from './parse';
import { SPECS } from './registry';
import { thrownBy } from './thrown-by-fixture';

const ctxFor = (argv: readonly string[], cwd: string): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd,
  runner: exec,
  env: {},
  bunVersion: REQUIRED_BUN,
});

/** An app root `requireAppRoot` accepts; its `.x/` is where the embedded database boots. */
async function appRoot(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'x-db-diag-'));
  await Bun.write(join(dir, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  return dir;
}

/** A WASM compile plus an initdb — a hang detector, not a budget. */
const PGLITE_BOOT_MS = 120_000;

/**
 * `x db diagnostics` against the app's own embedded database: the `--json` body is the report,
 * every section present, `slowQueries` unavailable (PGlite has no `pg_stat_statements`), exit 0.
 */
describe('unit · x db diagnostics', () => {
  test(
    '--json carries seven sections, slowQueries unavailable on the embedded database, exit 0',
    async () => {
      const root = await appRoot();
      try {
        const result = await dbCommand.run(ctxFor(['db', 'diagnostics', '--json'], root));
        const body = JSON.parse(renderJson(result)) as {
          readonly ok: boolean;
          readonly data: Readonly<Record<string, { readonly available: boolean }>>;
        };
        expect(body.ok).toBe(true);
        expect(Object.entries(body.data).map(([name, s]) => [name, s.available])).toEqual([
          ['blockers', true],
          ['activity', true],
          ['slowQueries', false],
          ['unusedIndexes', true],
          ['invalidIndexes', true],
          ['notValidConstraints', true],
          ['deadTuples', true],
        ]);
        expect(body.data['slowQueries']).toMatchObject({ code: 'X_DB_SCHEMA_STALE' });
        // `X_DB_LOCK_TIMEOUT`'s jq path, walked over this real body: `.data.<section>.rows` is an
        // array. Its field names are held to a real blocker row by `db-diagnostics.live.test.ts`.
        const lockFix = driverError('alter table posts', { errno: '55P03', severity: 'ERROR' }).fix;
        const section = /jq '\.data\.(\w+)\.rows\[\] \|/.exec(lockFix)?.[1] ?? '';
        expect(section).toBe('blockers');
        expect(Array.isArray((body.data[section] as { rows?: unknown }).rows)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    PGLITE_BOOT_MS,
  );

  test('the spec row parses, --limit is its own and help lists it', () => {
    expect(DB_SUBCOMMANDS).toContain('diagnostics');
    const args = parseArgs(['db', 'diagnostics', '--limit', '5'], SPECS);
    expect(args.subcommand).toBe('diagnostics');
    expect(flagString(args, 'limit')).toBe('5');
    expect(parseArgs(['db', 'diagnostics', '--help'], SPECS).help).toBe(true);
    expect(renderHelp(SPECS, 'db').join('\n')).toContain('diagnostics [--limit n]');
    const refused = thrownBy(() => parseArgs(['db', 'gen', 'x', '--limit', '5'], SPECS));
    expect(refused.code).toBe('X_CLI_BAD_FLAG');
  });

  test("X_DB_LOCK_TIMEOUT's fix cites a command this build resolves", async () => {
    const fix = driverError('alter table posts', { errno: '55P03', severity: 'ERROR' }).fix;
    expect(fix.startsWith('x db diagnostics --json | jq ')).toBe(true);
    expect(citedCommandProblem(fix, await loadCommandCatalog())).toBeUndefined();
    expect(fixProblem(fix)).toBeUndefined();
  });
});
