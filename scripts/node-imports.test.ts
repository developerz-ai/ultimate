// The enforcement half of `scripts/node-imports.ts`: this file IS the build error. The gate's
// `unit` step runs every `scripts/**/*.test.ts`, so a new unexplained `node:` import fails
// `bun run verify` with no extra wiring.

import { describe, expect, test } from 'bun:test';
import { NODE_IMPORT_PINS } from './lib/node-import-pins';
import { repoRoot } from './lib/run';
import {
  checkNodeImports,
  hasWhy,
  nodeImportFindingFor,
  nodeImportGaps,
  scanNodeImports,
} from './node-imports';

const found = (source: string): readonly string[] =>
  scanNodeImports('packages/x/src/a.ts', source).map((site) => site.specifier);

describe('a node: import with nothing saying why', () => {
  test('a static import is reported, with the specifier', () => {
    expect(found("import { writeSync } from 'node:fs';")).toEqual(['node:fs']);
  });

  test('every spelling that reaches a builtin', () => {
    expect(found("import 'node:crypto';")).toEqual(['node:crypto']);
    expect(found("const h = await import('node:async_hooks');")).toEqual(['node:async_hooks']);
    expect(found("const p = require('node:path');")).toEqual(['node:path']);
    expect(found("import { join } from 'node:path/posix';")).toEqual(['node:path/posix']);
  });

  test('the finding names the token to write and gives a worked example', () => {
    const gaps = checkNodeImports({
      files: [{ path: 'packages/x/src/log.ts', source: "import { writeSync } from 'node:fs';" }],
      pins: {},
    });
    const finding = nodeImportFindingFor(gaps[0] as never);
    expect(finding.code).toBe('X_NODE_IMPORT_UNEXPLAINED');
    expect(finding.at).toBe('packages/x/src/log.ts:1');
    expect(finding.fix).toContain('why:');
  });
});

describe('what counts as saying why', () => {
  test('the token on the import own line', () => {
    expect(
      found("import { writeSync } from 'node:fs'; // why: Bun has no sync stdout write"),
    ).toEqual([]);
  });

  test('a line comment directly above', () => {
    expect(
      found("// why: Bun ships no temp-directory API\nimport { mkdtemp } from 'node:fs';"),
    ).toEqual([]);
  });

  test('a doc comment above, which is where this framework already writes the sentence', () => {
    const source = [
      '/**',
      ' * The one synchronous stdout write there is.',
      ' * why: Bun has no synchronous stdout write of its own.',
      ' */',
      "import { writeSync } from 'node:fs';",
    ].join('\n');
    expect(found(source)).toEqual([]);
  });

  test('WHY: counts — the token, not its casing', () => {
    expect(found("// WHY: no Bun equivalent\nimport { tmpdir } from 'node:os';")).toEqual([]);
  });

  /**
   * The rule that makes "directly above" mean something: a `why:` written for one import must not
   * silently cover the next one, three statements down.
   */
  test('a why: separated by a statement covers nothing', () => {
    const source = [
      '// why: Bun ships no temp-directory API',
      "import { mkdtemp } from 'node:fs/promises';",
      "import { tmpdir } from 'node:os';",
    ].join('\n');
    expect(found(source)).toEqual(['node:os']);
  });

  test('a blank line between the comment and the import is still directly above', () => {
    expect(found("// why: no Bun path joiner\n\nimport { join } from 'node:path';")).toEqual([]);
  });

  test('hasWhy is asked of lines, so it can be reasoned about on its own', () => {
    expect(hasWhy(['// why: x', "import 'node:fs';"], 1)).toBe(true);
    expect(hasWhy(['const a = 1;', "import 'node:fs';"], 1)).toBe(false);
  });
});

describe('what the rule stays silent about', () => {
  test('a commented-out import is not an import', () => {
    expect(found("// import { writeSync } from 'node:fs';")).toEqual([]);
    expect(found("/**\n * import { writeSync } from 'node:fs';\n */")).toEqual([]);
  });

  /**
   * The half a line-prefix test cannot see, and the reason the mask replaced one: the comment does
   * not start the line, so `trimStart().startsWith('//')` reads straight past it.
   */
  test('a trailing comment on a line of real code is still a comment', () => {
    expect(found("const a = 1; // import { writeSync } from 'node:fs';")).toEqual([]);
  });

  test('a package specifier that merely starts with the letters is not a builtin', () => {
    expect(found("import { x } from 'nodemailer';")).toEqual([]);
    expect(found("import { x } from './node-imports';")).toEqual([]);
  });
});

/**
 * INPUT vs IMPORT. A rule's own test spells the forbidden shape as DATA and hands it to the pure
 * function above — this file does it two dozen times — and a checker that reports its own fixtures
 * is a checker whose count nobody can drain. Both carriers are exempt, and the COMMENT one is the
 * half a string-literal exemption alone misses: `scripts/async-context-guard.test.ts:106` explains
 * the shape by quoting it in a doc comment. `dead-docs-host.ts` states the same carve-out — "a
 * comment naming the host as the thing that was removed cannot 404".
 */
describe('a fixture is not an import', () => {
  test('inside a string literal — the shape as this test own data', () => {
    expect(found(`const fixture = "import { tmpdir } from 'node:os';";`)).toEqual([]);
    expect(found("const fixture = `import { tmpdir } from 'node:os';`;")).toEqual([]);
  });

  test('inside a comment — prose ABOUT the shape, which no process evaluates', () => {
    const source = [
      '/**',
      " * A module may not write `import { tmpdir } from 'node:os';` without saying why.",
      ' */',
      'export const RULE = 1;',
    ].join('\n');
    expect(found(source)).toEqual([]);
  });

  test('a real import in the same file as a fixture is still reported', () => {
    const source = [
      `const fixture = "import { tmpdir } from 'node:os';";`,
      "import { join } from 'node:path';",
    ].join('\n');
    expect(found(source)).toEqual(['node:path']);
    expect(scanNodeImports('packages/x/src/a.ts', source)[0]?.line).toBe(2);
  });
});

describe('a test file is source', () => {
  /**
   * The whole of #365. `checkNodeImports` opened `if (isTestPath(file.path)) continue`, so a
   * package could hold a dozen unexplained imports in its suites under a green gate — and one did:
   * `storage` was flagged by review on #364 with no row in the pin table at all.
   */
  test('an unexplained node: import in a .test.ts is reported', () => {
    const gaps = checkNodeImports({
      files: [{ path: 'packages/x/src/a.test.ts', source: "import { tmpdir } from 'node:os';" }],
      pins: {},
    });
    expect(gaps.map((gap) => `${gap.pkg}:${String(gap.found)}`)).toEqual(['x:1']);
    expect(nodeImportFindingFor(gaps[0] as never).at).toBe('packages/x/src/a.test.ts:1');
  });

  test('and a why: in a test file clears it, the same sentence a driver writes', () => {
    expect(
      checkNodeImports({
        files: [
          {
            path: 'packages/x/src/a.test.ts',
            source: "// why: Bun exposes no tmpdir()\nimport { tmpdir } from 'node:os';",
          },
        ],
        pins: {},
      }),
    ).toEqual([]);
  });
});

describe('the ratchet', () => {
  test('a pin above what the tree holds is stale, with the command that lowers it', () => {
    const gaps = checkNodeImports({
      files: [{ path: 'packages/x/src/a.ts', source: 'const a = 1;' }],
      pins: { x: 2 },
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(['stale']);
    expect(nodeImportFindingFor(gaps[0] as never).code).toBe('X_NODE_IMPORT_PIN_STALE');
  });

  test('an empty corpus is UNSCANNED, never a clean tree', () => {
    expect(nodeImportFindingFor(checkNodeImports({ files: [], pins: {} })[0] as never).code).toBe(
      'X_NODE_IMPORT_UNSCANNED',
    );
  });

  /**
   * The pins are a MEASUREMENT and may only fall. A ceiling rather than an equality, so a slice
   * that writes ten `why:` lines does not have to come back here to be allowed to.
   */
  test('no pin has been raised past what the widened corpus measured', () => {
    // 2026-08-26, the run in which a test file entered the corpus (#365) — 545 across 16 packages.
    // The 2026-08-23 ceiling it replaces (146 across 10) measured shipped source alone, so it is
    // not comparable and cannot be the ratchet's floor. This one may only fall.
    const dayOne: Readonly<Record<string, number>> = {
      admin: 1,
      ai: 9,
      cli: 360,
      core: 17,
      db: 8,
      entity: 1,
      i18n: 3,
      jobs: 2,
      manifest: 11,
      notify: 1,
      render: 15,
      scraping: 4,
      scripts: 99,
      testing: 12,
      time: 1,
      ui: 1,
    };
    for (const [pkg, count] of Object.entries(NODE_IMPORT_PINS)) {
      expect(count).toBeLessThanOrEqual(dayOne[pkg] ?? 0);
    }
  });

  test('the tree is on the ratchet', async () => {
    expect(await nodeImportGaps(repoRoot())).toEqual([]);
  });
});
