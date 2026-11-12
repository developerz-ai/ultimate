// `statementExcerpt` is a linear scan now, so the claims are two: for every ordinary statement it
// answers what the regex spelling it replaced answered, and an adversarial input — a long run of
// whitespace between comments, the shape CodeQL's polynomial-ReDoS rule flags — costs one pass.

import { describe, expect, test } from 'bun:test';
import { statementExcerpt } from './statement-excerpt';

/** The spelling it replaced, kept as the oracle for ordinary input. */
const reference = (statement: string): string => {
  const line = statement
    .replace(/^(?:\s*(?:--[^\n]*|\/\*[\s\S]*?\*\/)\s*)+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
};

const ORDINARY = [
  '',
  '   ',
  'select 1',
  '  select\n\t*  from   "t"\r\nwhere a = $1  ',
  '-- header\n-- backfill note\ndrop table "posts"',
  '/* block */ /* another\n spanning */  alter table t add column c int',
  '-- only a comment',
  '/* unclosed comment select 1',
  '/*/ not closed by its own star */ select 2',
  '--x\n  /**/--y\nupdate t set a = 1 -- trailing stays\nwhere id = 2',
  "insert into t (a) values ('-- not a comment')",
  `select ${'a, '.repeat(80)}b from t`,
  `-- c\n${'x'.repeat(117)}`,
  `-- c\n${'x'.repeat(120)}`,
  `-- c\n${'x'.repeat(121)}`,
  `${'y'.repeat(119)}    z`,
  'select   1　from t',
  'copy "t" ("a") from stdin',
];

describe('statementExcerpt', () => {
  for (const statement of ORDINARY) {
    test(`the regex spelling's answer: ${JSON.stringify(statement.slice(0, 40))}`, () => {
      expect(statementExcerpt(statement)).toBe(reference(statement));
    });
  }

  test('adversarial whitespace between comments: one pass, bounded by size', () => {
    const size = 200_000;
    const inputs = [
      `/**/${' '.repeat(size)}x`,
      `${'/**/ '.repeat(size / 5)}/*`,
      `${'--\n'.repeat(size / 3)}${' \t'.repeat(size / 2)}`,
      `/*${' '.repeat(size)}`,
      `select${' '.repeat(size)}1`,
    ];
    const started = performance.now();
    for (const input of inputs) expect(statementExcerpt(input).length).toBeLessThanOrEqual(120);
    // Linear work over ~1M characters is milliseconds; a quadratic scan is minutes. Loose on purpose.
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('the excerpt stops reading once it has 121 characters', () => {
    const long = `select ${'z'.repeat(5_000_000)}`;
    expect(statementExcerpt(long)).toBe(`select ${'z'.repeat(110)}...`);
  });
});
