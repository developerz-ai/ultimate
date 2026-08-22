// This package ships four of the framework's six primitive factories, so it is where the
// "Nth instance of the factory rule" sentence was written most often — and every ordinal in it
// was wrong the moment a later one landed. `PRIMITIVE_FACTORIES` in `@ultimat3/core` is the
// derived list; prose points at it and never counts.

import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PRIMITIVE_FACTORIES } from '@ultimat3/core';

/**
 * Deliberately matched on the ORDINAL WORD next to "instance", not on the whole sentence: the
 * three spellings that shipped ("the third instance of the framework's rule", "The fourth
 * instance of the framework's factory rule", "the FOURTH instance of the factory rule") differ in
 * wording, casing and emphasis, and a pattern keyed on any one of them would have caught one.
 */
const ORDINAL_CLAIM =
  /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)\b[^.\n]{0,40}\binstance\b[^.\n]{0,60}\b(factory\s+rule|rule)\b/i;

const PACKAGE_ROOT = new URL('..', import.meta.url).pathname;

async function prose(): Promise<readonly (readonly [string, string])[]> {
  const src = join(PACKAGE_ROOT, 'src');
  const names = (await readdir(src)).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
  );
  const files = [...names.map((name) => join(src, name)), join(PACKAGE_ROOT, 'CLAUDE.md')];
  return Promise.all(files.map(async (path) => [path, await Bun.file(path).text()] as const));
}

describe('unit · a factory is a row in PRIMITIVE_FACTORIES, never an ordinal in a comment', () => {
  test('no file in this package counts the factory rule', async () => {
    const offenders = (await prose())
      .filter(([, text]) => ORDINAL_CLAIM.test(text))
      .map(([path]) => path.slice(PACKAGE_ROOT.length));
    // A count in prose is unfalsifiable from inside the file that writes it: `hive.ts` said
    // "fourth" and `agent.ts` said "third" while six factories shipped, and neither file can see
    // the other. `PRIMITIVE_FACTORIES` is the list a reader is sent to instead.
    expect(offenders).toEqual([]);
  });

  test('the pattern catches the exact sentences that shipped — this test can fail', () => {
    expect(ORDINAL_CLAIM.test("The fourth instance of the framework's factory rule, after")).toBe(
      true,
    );
    expect(ORDINAL_CLAIM.test("The third instance of the framework's rule, after `llm()`")).toBe(
      true,
    );
    expect(ORDINAL_CLAIM.test('and the FOURTH instance of the factory rule')).toBe(true);
    expect(ORDINAL_CLAIM.test('one factory per primitive, listed in PRIMITIVE_FACTORIES')).toBe(
      false,
    );
  });

  test('this package really does own more than one of them, so the count was always fragile', () => {
    const mine = PRIMITIVE_FACTORIES.filter((entry) => entry.pkg === '@ultimat3/ai');
    expect(mine.map((entry) => entry.factory)).toEqual(['agent', 'agentJob', 'hive', 'llm']);
  });
});
