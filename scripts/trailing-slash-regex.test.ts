// The enforcement half of `scripts/trailing-slash-regex.ts`: this file IS the build error. The
// gate's `unit` step runs every `scripts/**/*.test.ts`, so a `/\/+$/` written back into shipped
// source fails `bun run verify` with no extra wiring. The real tree is asserted NON-VACUOUSLY: a
// scanner that read nothing reports nothing, which is what a clean tree reports too.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
  checkTrailingSlashRegexes,
  type TrailingSlashSource,
  trailingSlashRegexFindings,
  trailingSlashRegexResult,
} from './trailing-slash-regex';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const file = (path: string, text: string): TrailingSlashSource => ({ path, text });
const lines = (path: string, text: string): readonly string[] =>
  checkTrailingSlashRegexes([file(path, text)]).map((one) => one.at ?? '');

describe('the quadratic trailing-slash regex is refused in every spelling that trims', () => {
  test('`/\\/+$/` is the finding, at its own line, with the helper as the fix', () => {
    const source = "const a = 1;\nexport const base = (u: string) => u.replace(/\\/+$/, '');\n";
    const findings = checkTrailingSlashRegexes([file('packages/x/src/base.ts', source)]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('X_TRAILING_SLASH_REGEX');
    expect(findings[0]?.at).toBe('packages/x/src/base.ts:2');
    expect(findings[0]?.fix).toContain('trimTrailingSlashes');
    expect(findings[0]?.cause).toContain('packages/x/src/base.ts:2');
  });

  test('the trivial variants are the same regex: `*`, a class, `{1,}`, a flag', () => {
    const variants = ['/\\/*$/', '/[/]+$/', '/[\\/]+$/', '/\\/{1,}$/', '/\\/+$/g', '/\\/+$/u'];
    for (const re of variants) {
      expect(lines('scripts/a.ts', `s.replace(${re}, '');\n`)).toEqual(['scripts/a.ts:1']);
    }
  });

  test('a trailing alternative is the same scan: `/^\\/+|\\/+$/g`', () => {
    expect(lines('scripts/a.ts', "p.replace(/^\\/+|\\/+$/g, '');\n")).toEqual(['scripts/a.ts:1']);
  });

  test('a `.test()` or `.search()` of the shape is the same scan, not only a replace', () => {
    expect(lines('scripts/a.ts', 'const ends = /\\/+$/.test(p);\n')).toEqual(['scripts/a.ts:1']);
  });

  test('two in one file are two findings', () => {
    const source = "a.replace(/\\/+$/, '');\nb.replace(/\\/+$/, '');\n";
    expect(lines('scripts/a.ts', source)).toEqual(['scripts/a.ts:1', 'scripts/a.ts:2']);
  });
});

describe('what is not the scan', () => {
  // `^\/+$` asks whether a string is ALL slashes: anchored at the start, one attempt, linear.
  test('an anchored-at-start `/^\\/+$/` is a whole-string test, not a trim', () => {
    expect(lines('scripts/a.ts', 'const allSlashes = /^\\/+$/.test(p);\n')).toEqual([]);
  });

  // A required character before the run pins where an attempt can start.
  test('a run after a required character is not the unanchored scan', () => {
    expect(lines('scripts/a.ts', 'const dir = /x\\/+$/.test(p);\n')).toEqual([]);
  });

  test('the shape quoted in a string or a comment is prose, not a regex', () => {
    const source = [
      '// we used to write /\\/+$/ here',
      "const why = 'replaced /\\\\/+$/ with trimTrailingSlashes';",
      '/** `/\\/+$/` is quadratic */',
      // `\/` in a string is a plain `/`: the text is the regex, delimiters and all, and only the
      // masked view knows the quote opened it.
      'const doc = "/\\/+$/";',
    ].join('\n');
    expect(lines('scripts/a.ts', source)).toEqual([]);
  });

  test('a leading trim alone is linear and is not refused', () => {
    expect(lines('scripts/a.ts', "p.replace(/^\\/+/, '');\n")).toEqual([]);
  });
});

describe('the command', () => {
  test('a finding is in `findings`, so `--json` carries it', () => {
    const result = trailingSlashRegexResult([file('scripts/a.ts', "p.replace(/\\/+$/, '');\n")]);
    expect(result.ok).toBe(false);
    expect(result.findings?.map((one) => one.code)).toEqual(['X_TRAILING_SLASH_REGEX']);
  });

  test('a clean scan says how many files it read', () => {
    const result = trailingSlashRegexResult([file('scripts/a.ts', 'export {};\n')]);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ scanned: 1 });
  });
});

describe('this repository', () => {
  test('trims a trailing slash run one way: trimTrailingSlashes', async () => {
    expect(await trailingSlashRegexFindings(repoRoot())).toEqual([]);
  });
});
