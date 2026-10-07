// The planner's reach: every real package it must be able to add a code to, and the code NAME table
// (`SEO_ERROR_CODES`) a registration is not complete without. Split from `new-error-code.test.ts`
// at the 500-line ceiling along that seam.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { codeNameIn } from './lib/error-code-plan';
import { REPO_SCAN_TIMEOUT_MS } from './lib/run';
import { ScriptError } from './lib/script-error';
import { tierOf } from './lib/tiers';
import { newErrorCode, planFiles, STATUS_TABLE_MAX_TIER } from './new-error-code';
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

describe('the code name table joins every registration', () => {
  test('seo: the code also joins SEO_ERROR_CODES, or SeoErrorCode cannot name it', async () => {
    const dir = await fixtureRoot();
    await newErrorCode(dir, [
      'X_SEO_ALT_MISSING',
      '--package',
      'seo',
      '--title',
      'an image with no alt text',
      '--cause',
      'what usually makes it happen',
      '--fix',
      'add alt to the <img> the cause names',
      '--off-socket',
    ]);
    const errors = await read(dir, 'packages/seo/src/errors.ts');
    expect(errors).toContain("  altMissing: 'X_SEO_ALT_MISSING',\n} as const;");
    expect(transpiles(errors)).toBe(true);
  });

  test('seo: a code name already in the table is refused, nothing written', async () => {
    const dir = await fixtureRoot();
    expect(
      await refusal(
        newErrorCode(dir, [
          'X_SEO_META_MISSING',
          '--package',
          'seo',
          '--title',
          't',
          '--cause',
          'c',
          '--fix',
          'f',
          '--off-socket',
        ]),
      ),
    ).toBe('X_NEW_ERROR_CODE_EXISTS');
  });

  test('ui: the registry file takes the title and errors.ts takes the name', async () => {
    const plan = await planFiles(
      ROOT,
      { code: 'X_UI_PROBE_ONLY', pkg: 'ui', title: 't', cause: 'c', fix: 'f' },
      { kind: 'row', status: 500 },
    );
    expect(plan.errorsPath).toBe('packages/ui/src/error-registry.ts');
    expect(plan.errorsTs).toContain("X_UI_PROBE_ONLY: { title: 't' }");
    expect(plan.names?.path).toBe('packages/ui/src/errors.ts');
    expect(plan.names?.text).toContain("  probeOnly: 'X_UI_PROBE_ONLY',\n} as const;");
  });
});

describe('the code name table shapes the planner reads', () => {
  const input = { code: 'X_ABC_NEW_THING', pkg: 'abc', title: 't', cause: 'c', fix: 'f' };
  const table = (body: string): string => `export const ABC_ERROR_CODES = {${body}} as const;\n`;

  test('an empty table takes its first name', () => {
    expect(codeNameIn(table('\n'), 'p', input, false)).toBe(
      table("\n  newThing: 'X_ABC_NEW_THING',\n"),
    );
    expect(codeNameIn(table(''), 'p', input, false)).toContain("newThing: 'X_ABC_NEW_THING'");
  });

  test('a table with a wrapped entry is read as a table, and the name is added', () => {
    const wrapped = table(`\n  aVeryLongName:\n    'X_ABC_${'LONG_'.repeat(14)}CODE',\n`);
    expect(codeNameIn(wrapped, 'p', input, false)).toContain("  newThing: 'X_ABC_NEW_THING',");
  });

  test('a table holding anything else is not one', () => {
    expect(codeNameIn(table("\n  a: 'not a code',\n"), 'p', input, false)).toBeUndefined();
  });

  test('a taken name is refused with a fix that opens as a command', () => {
    try {
      codeNameIn(table("\n  newThing: 'X_ABC_OTHER',\n"), 'p', input, true);
      expect.unreachable('the taken name was accepted');
    } catch (error) {
      if (!(error instanceof ScriptError)) throw error;
      expect(error.code).toBe('X_NEW_ERROR_CODE_INVALID');
      expect(error.fix).toStartWith('bun run scripts/new-error-code.ts');
    }
  });
});

describe('every real workspace is a package the planner can add to', () => {
  // The planner refused action, http, realtime (titles in `error-titles.ts`) and ui (`error-registry.ts`)
  // with X_NEW_ERROR_CODE_PATTERN_UNKNOWN: a command the docs name for "a new code" that did not
  // work for four of the packages that own the most of them.
  const probe = (pkg: string) => ({
    code: 'X_PROBE_ONLY_CODE',
    pkg,
    title: 'a probe',
    cause: 'a test',
    fix: 'x doctor',
  });

  test('planFiles succeeds on a probe code for each non-private package under packages/', async () => {
    const refused: Record<string, string> = {};
    let planned = 0;
    for (const path of new Bun.Glob('*/package.json').scanSync({ cwd: `${ROOT}/packages` })) {
      const manifest = (await Bun.file(`${ROOT}/packages/${path}`).json()) as {
        private?: boolean;
      };
      if (manifest.private === true) continue;
      const pkg = path.replace('/package.json', '');
      // The tier-6 shim over the CLI: it owns no codes, so "no file registers any" is its answer.
      if (pkg === 'create-ultimate') {
        expect(await refusal(planFiles(ROOT, probe(pkg)))).toBe('X_NEW_ERROR_CODE_INVALID');
        continue;
      }
      const decision =
        tierOf(pkg) > STATUS_TABLE_MAX_TIER
          ? ({ kind: 'none' } as const)
          : ({ kind: 'row', status: 500 } as const);
      try {
        const plan = await planFiles(ROOT, probe(pkg), decision);
        expect(transpiles(plan.errorsTs), pkg).toBe(true);
        expect(plan.errorsTs, pkg).toContain('X_PROBE_ONLY_CODE');
        planned += 1;
      } catch (error) {
        refused[pkg] = error instanceof ScriptError ? error.code : 'crash';
      }
    }
    expect(refused).toEqual({});
    expect(planned).toBeGreaterThanOrEqual(30);
  });
});
