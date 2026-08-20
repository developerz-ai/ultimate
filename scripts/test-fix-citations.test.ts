// The scanner's own cases, as fixtures. What matters here is not that it FINDS a bad command —
// `citedCommandProblem` owns that — but what it agrees to call a citation at all.

import { describe, expect, test } from 'bun:test';
import type { CommandCatalog } from '@ultimat3/cli';
import { sourceStrings } from './lib/source-strings';
import { checkTestFixes, packageOf, scanTestFixes, type TestFixGap } from './test-fix-citations';

/** One command, one subcommand — enough for `citedCommandProblem` to answer, and no more. */
const CATALOG: CommandCatalog = {
  specs: [
    {
      name: 'db',
      summary: 'db',
      usage: 'x db migrate',
      flags: [],
      positionalChoices: ['migrate'],
    },
  ],
  planned: new Set<string>(),
  plannedSubcommands: new Set<string>(),
} as unknown as CommandCatalog;

const found = (source: string): readonly string[] =>
  scanTestFixes('packages/p/src/a.test.ts', source).map((c) => c.fix);

describe('what the scanner agrees to call a citation', () => {
  test('a fix: property and a fix assertion both count', () => {
    expect(found("const e = { fix: 'x db migrate' };")).toEqual(['x db migrate']);
    expect(found("expect(err.fix).toBe('x db migrate');")).toEqual(['x db migrate']);
    expect(found("expect(e.fix).toContain('x db migrate');")).toEqual(['x db migrate']);
  });

  test('a command in a COMMENT is prose about a command, never a use of one', () => {
    expect(found("// the fix: 'x db nope' is not a real command\nconst a = 1;")).toEqual([]);
    expect(found("/* fix: 'x db nope' */\nconst a = 1;")).toEqual([]);
  });

  test('a command inside another string is a fixture’s source text, not this file’s value', () => {
    // packages/cli/src/error-contract.test.ts does exactly this, seven times, to prove the rule
    // that reads `src/` bites. The exemption is a property of the code, not a filename allowlist.
    expect(found(`await write('a.ts', "throw new E({ fix: 'x db nope' });");`)).toEqual([]);
  });

  test('a NEGATED assertion is the rule being enforced, not broken', () => {
    expect(found("expect(err.fix).not.toContain('x db nope');")).toEqual([]);
    expect(found("expect(err.fix).not.toBe('x db nope');")).toEqual([]);
  });

  test('a string that is not a command is left alone', () => {
    expect(found("const e = { fix: 'edit packages/db/src/pool.ts' };")).toEqual([]);
  });
});

describe('the tokenizer the exemption rests on', () => {
  test('a nested literal is returned whole and never re-read as code', () => {
    const strings = sourceStrings(`write('a.ts', "fix: 'x db nope'");`);
    expect(strings.map((s) => s.value)).toEqual(['a.ts', "fix: 'x db nope'"]);
  });

  test('an escaped quote does not end the literal', () => {
    expect(sourceStrings(`const a = 'it\\'s fine';`).map((s) => s.value)).toEqual(["it's fine"]);
  });

  test('line numbers survive a multi-line block comment', () => {
    expect(sourceStrings("/* a\nb */\nconst x = 'y';")[0]?.line).toBe(3);
  });
});

describe('the ratchet', () => {
  const gaps = (text: string, pins: Record<string, number>): readonly TestFixGap[] =>
    checkTestFixes({
      files: [{ path: 'packages/db/src/a.test.ts', text }],
      catalog: CATALOG,
      pins,
    });

  test('a package over its pin is the hazard', () => {
    const [gap] = gaps("const e = { fix: 'x db nope' };", {});
    expect(gap?.kind).toBe('over');
    expect(gap?.pkg).toBe('db');
    expect(gap?.first?.at).toBe('packages/db/src/a.test.ts:1');
  });

  test('a package at its pin is silent, and one under it is stale', () => {
    expect(gaps("const e = { fix: 'x db nope' };", { db: 1 })).toEqual([]);
    expect(gaps('const a = 1;', { db: 1 })[0]?.kind).toBe('stale');
  });

  test('a file set that matched nothing is a finding, not agreement', () => {
    const [gap] = checkTestFixes({ files: [], catalog: CATALOG, pins: {} });
    expect(gap?.kind).toBe('unscanned');
  });
});

describe('packageOf', () => {
  test('names the package a pin is keyed by', () => {
    expect(packageOf('packages/db/src/a.test.ts')).toBe('db');
    expect(packageOf('scripts/verify.test.ts')).toBe('scripts');
  });
});
