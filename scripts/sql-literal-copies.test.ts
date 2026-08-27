// The enforcement half of `scripts/sql-literal-copies.ts`: this file IS the build error. The real
// tree is asserted NON-VACUOUSLY — a scan that matched nothing would report "one module builds a
// SQL string literal", which is the answer a correct tree gives, and is exactly how three copies of
// the escape shipped with two of them wrong.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { collectSourceFiles, type SourceFile } from './boundaries';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { checkLiteralCopies, literalCopies, OWNER } from './sql-literal-copies';

// Every test below scans the whole tree, so the budget is the file's default rather than a third
// argument per test — see `REPO_SCAN_TIMEOUT_MS`. This file ran on Bun's 5000ms default until
// 2026-08-27 and went red on a runtime 1.3x slower, which is less than one noisy CI runner.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const COPY = 'X_SQL_LITERAL_COPY';
const UNSCANNED = 'X_SQL_LITERAL_UNSCANNED';

const file = (path: string, source: string): SourceFile => ({ path, source });

/**
 * The escape as it really appears, built by concatenation so this file does not become its own
 * first finding. `isTestPath` already exempts it — belt and braces, because the exemption is what
 * a future edit is most likely to break.
 */
const ESCAPE = `.replaceAll("'", ${JSON.stringify("''")})`;

describe('what counts as building a SQL string literal', () => {
  test('the replacement is the discriminator, in either quoting style', () => {
    const found = literalCopies([
      file('packages/a/src/one.ts', `const q = value${ESCAPE};`),
      file('packages/b/src/two.ts', `const q = value.replace(/'/g, ${JSON.stringify("''")});`),
    ]);
    expect(found.map((one) => one.file)).toEqual([
      'packages/a/src/one.ts',
      'packages/b/src/two.ts',
    ]);
  });

  test('the owner may spell it — everything else imports what it exports', () => {
    expect(literalCopies([file(OWNER, `const q = value${ESCAPE};`)])).toEqual([]);
  });

  test('a COMMENT describing the escape is not an escape', () => {
    // `dead-docs-host` draws the same line: naming the thing that was removed cannot be the thing.
    // Both this script's header and the entity module recording why its copies were deleted spell
    // the call verbatim, and neither builds any SQL.
    expect(
      literalCopies([file('packages/a/src/one.ts', `// we used to write value${ESCAPE}`)]),
    ).toEqual([]);
  });

  test('the line is the call, and survives the comment masking', () => {
    // The masker blanks a comment LINE rather than deleting it, so the line count is preserved and
    // the character offsets are not. Reading the position off the original source reported line 2
    // for a call on line 4 — the assertion that caught it.
    const found = literalCopies([
      file(
        'packages/a/src/one.ts',
        [
          '// a long comment line that is blanked',
          '// and another',
          '',
          `const q = v${ESCAPE};`,
        ].join('\n'),
      ),
    ]);
    expect(found[0]?.line).toBe(4);
  });

  test('a test may assert the escape, and a template is the app’s own SQL', () => {
    expect(
      literalCopies([
        file('packages/a/src/one.test.ts', `expect(v${ESCAPE}).toBe("''");`),
        file('packages/cli/src/templates/seed.ts', `const q = v${ESCAPE};`),
      ]),
    ).toEqual([]);
  });

  test('an ordinary replace is not one — the rule is narrow on purpose', () => {
    expect(
      literalCopies([
        file('packages/a/src/one.ts', `const s = value.replaceAll('-', '_');`),
        file('packages/a/src/two.ts', `const s = value.replaceAll('"', '\\\\"');`),
      ]),
    ).toEqual([]);
  });
});

describe('the finding', () => {
  test('names the site and the remedy, and says why doubling is not enough', () => {
    const findings = checkLiteralCopies({
      copies: [{ file: 'packages/entity/src/expr.ts', line: 12, excerpt: ESCAPE }],
      ownerSeen: true,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe(COPY);
    expect(findings[0]?.at).toBe('packages/entity/src/expr.ts:12');
    expect(findings[0]?.cause).toContain('standard_conforming_strings');
    expect(findings[0]?.fix).toContain("import { literal } from '@ultimat3/db'");
  });

  test('a rule that read nothing says so, rather than reporting a clean tree', () => {
    const findings = checkLiteralCopies({ copies: [], ownerSeen: false });
    expect(findings[0]?.code).toBe(UNSCANNED);
    expect(findings[0]?.at).toBe(OWNER);
  });
});

describe('the real tree', () => {
  test('one module builds a SQL string literal, and the scan actually reached it', async () => {
    const files = await collectSourceFiles(repoRoot());
    const ownerSeen = files.some((one) => one.path === OWNER);
    // Non-vacuity, both directions: the owner was scanned, AND the owner really does spell the
    // escape. Without the second assertion a rename inside sql.ts would make this suite green by
    // making the rule blind.
    expect(ownerSeen).toBe(true);
    const owner = files.find((one) => one.path === OWNER);
    expect(owner?.source).toContain("''");

    expect(checkLiteralCopies({ copies: literalCopies(files), ownerSeen })).toEqual([]);
  });
});
