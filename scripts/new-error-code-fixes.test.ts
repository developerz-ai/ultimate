// A package that types one fix per code (`FIX_TABLES`) gets that row in the same edit. Proved on a
// throwaway root holding copies of the CLI's real registration and its real `CLI_FIXES` table:
// `--package cli` used to write the title and stop, and the package stopped typechecking.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no recursive mkdir of its own; the fixture root needs the package directory.
import { mkdir } from 'node:fs/promises';
import { FIX_TABLES, fixRowIn } from './lib/error-code-plan';
import { REPO_SCAN_TIMEOUT_MS } from './lib/run';
import { newErrorCode, WIKI_PAGE } from './new-error-code';
import {
  fixtureRoot,
  ROOT,
  read,
  refusal,
  removeFixtureRoots,
  transpiles,
} from './new-error-code.fixtures';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);
afterAll(removeFixtureRoots);

const CODES = 'packages/cli/src/error-codes.ts';
const FIXES = 'packages/cli/src/mcp-errors.ts';
const ARGV = [
  'X_CLI_PROBE_ONLY',
  '--package',
  'cli',
  '--title',
  'a probe',
  '--cause',
  'what makes it happen',
  '--fix',
];

async function cliRoot(): Promise<string> {
  const dir = await fixtureRoot();
  await mkdir(`${dir}/packages/cli/src`, { recursive: true });
  for (const path of [CODES, FIXES]) await Bun.write(`${dir}/${path}`, Bun.file(`${ROOT}/${path}`));
  return dir;
}

/** The body of the `CLI_FIXES` literal: from its opening brace to the `};` that ends it. */
const fixesLiteral = (source: string): string => {
  const open = source.indexOf('const CLI_FIXES');
  return source.slice(open, source.indexOf('\n};', open));
};

describe('a package with a typed fix table', () => {
  test('cli: the registration, the wiki row AND the CLI_FIXES row land together', async () => {
    const dir = await cliRoot();
    const result = await newErrorCode(dir, [...ARGV, 'x doctor --json']);
    expect(result.written).toEqual([CODES, WIKI_PAGE, FIXES]);
    expect(result.fixesPath).toBe(FIXES);
    expect(result.statusPath).toBeUndefined();

    const fixes = await read(dir, FIXES);
    expect(fixesLiteral(fixes)).toContain("\n  X_CLI_PROBE_ONLY: 'x doctor --json',");
    expect(transpiles(fixes)).toBe(true);
    // Every `Record<CliErrorCode, string>` key the registration gained has its row: the pair is
    // what keeps the package typechecking after the one edit.
    expect(await read(dir, CODES)).toContain("'X_CLI_PROBE_ONLY',");
  });

  test('a long fix wraps the way Biome writes one, and a quote in it is escaped', async () => {
    const dir = await cliRoot();
    const fix = `x verify --only unit --json   # it's the finding that names ${'the file '.repeat(8)}`;
    await newErrorCode(dir, [...ARGV, fix.trim()]);
    const fixes = fixesLiteral(await read(dir, FIXES));
    expect(fixes).toContain("\n  X_CLI_PROBE_ONLY:\n    'x verify --only unit --json   # it\\'s");
    expect(transpiles(await read(dir, FIXES))).toBe(true);
  });

  test('a table that already names the code, or lost its literal, refuses and writes nothing', async () => {
    const dir = await cliRoot();
    const before = await read(dir, FIXES);
    await Bun.write(`${dir}/${FIXES}`, before.replace('const CLI_FIXES', 'const CLI_ANSWERS'));
    const codes = await read(dir, CODES);
    const wiki = await read(dir, WIKI_PAGE);
    expect(await refusal(newErrorCode(dir, [...ARGV, 'x doctor --json']))).toBe(
      'X_NEW_ERROR_CODE_INVALID',
    );
    expect(await read(dir, CODES)).toBe(codes);
    expect(await read(dir, WIKI_PAGE)).toBe(wiki);

    expect(() =>
      fixRowIn(before, FIXES, {
        code: 'X_VERIFY_FAILED',
        pkg: 'cli',
        title: 't',
        cause: 'c',
        fix: 'f',
      }),
    ).toThrow('X_NEW_ERROR_CODE_EXISTS');
  });

  test('a package with no fix table is planned exactly as before', async () => {
    const dir = await fixtureRoot();
    const result = await newErrorCode(dir, [
      'X_MONEY_PROBE_ONLY',
      '--package',
      'money',
      '--title',
      't',
      '--cause',
      'what usually makes it happen',
      '--fix',
      'x doctor --json',
      '--off-socket',
    ]);
    expect(result.fixesPath).toBeUndefined();
    expect(result.written).toHaveLength(3);
  });

  test('every FIX_TABLES path is a real file holding a literal the planner can add to', async () => {
    expect(FIX_TABLES.size).toBeGreaterThan(0);
    for (const [pkg, path] of FIX_TABLES) {
      const out = fixRowIn(await Bun.file(`${ROOT}/${path}`).text(), path, {
        code: 'X_PROBE_ONLY',
        pkg,
        title: 't',
        cause: 'c',
        fix: 'x doctor --json',
      });
      expect(transpiles(out)).toBe(true);
    }
  });
});
