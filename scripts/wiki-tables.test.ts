// The gate rule that keeps `wiki/`'s tables renderable. Every negative case is a FIXTURE string —
// never an edit to a published page — and the positive case that matters most is the escaped pipe:
// a checker that fails on the 36 correct `\|` rows already in `wiki/` is worse than no checker,
// because the first thing an author does is "fix" the good row.

import { describe, expect, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
  checkTables,
  isDelimiterRow,
  type MarkdownFile,
  readWiki,
  splitRow,
  tableGapFindingFor,
} from './wiki-tables';

const page = (text: string): readonly MarkdownFile[] => [{ path: 'wiki/Fixture.md', text }];

const findings = (text: string) => checkTables(page(text)).map(tableGapFindingFor);

/** A well-formed two-column table. `rows` extends it; a blank line would end the table instead. */
const table = (...rows: readonly string[]): string =>
  ['| a | b |', '|---|---|', '| one | two |', ...rows, ''].join('\n');

describe('unit · an escaped pipe is content, not a cell boundary', () => {
  test('a union literal in a cell passes — the row every naive checker breaks on', () => {
    const text = [
      '| Key | Type |',
      '|---|---|',
      "| `jobs.driver` | `'postgres' \\| 'redis' \\| 'nats'` |",
      '',
    ].join('\n');

    expect(splitRow("| `'a' \\| 'b'` | x |")).toEqual([" `'a' \\| 'b'` ", ' x ']);
    expect(findings(text)).toEqual([]);
  });

  test('an escaped BACKSLASH still leaves the pipe as a delimiter', () => {
    expect(splitRow('| a \\\\| b |')).toHaveLength(2);
  });
});

describe('unit · a row that does not match its header', () => {
  test('is refused, and the fix names the file, the line and the cell count', () => {
    const found = findings(table('| one | two | three |'));

    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe('X_WIKI_TABLE_MALFORMED');
    expect(found[0]?.cause).toContain('3 cells');
    expect(found[0]?.cause).toContain('header has 2');
    expect(found[0]?.at).toBe('wiki/Fixture.md:4');
    expect(found[0]?.fix).toContain('exactly 2 cells');
  });

  test('an UNescaped pipe inside a cell is exactly that failure, and is caught', () => {
    // The counterpart of the escaped case: `'a' | 'b'` written without the backslash silently
    // eats the next column on the published page.
    const found = findings(['| Key | Type |', '|---|---|', "| `x` | `'a' | 'b'` |", ''].join('\n'));

    expect(found).toHaveLength(1);
    expect(found[0]?.cause).toContain('3 cells');
  });

  test('the same table with matching rows passes', () => {
    expect(findings(table())).toEqual([]);
  });
});

describe('unit · a table that does not render as a table', () => {
  test('a delimiter row of the wrong width is refused', () => {
    const found = findings(['| a | b | c |', '|---|---|', '| 1 | 2 | 3 |', ''].join('\n'));

    expect(found[0]?.code).toBe('X_WIKI_TABLE_MALFORMED');
    expect(found[0]?.cause).toContain('GFM renders neither as a table');
    expect(found[0]?.at).toBe('wiki/Fixture.md:2');
    expect(found[0]?.fix).toContain('|---|---|---|');
  });

  test('a header with no delimiter row under it is refused', () => {
    const found = findings(['| a | b |', '| 1 | 2 |', ''].join('\n'));

    expect(found[0]?.cause).toContain('paragraph of literal pipes');
    expect(found[0]?.at).toBe('wiki/Fixture.md:1');
  });

  test('a delimiter row is recognised with alignment colons', () => {
    expect(isDelimiterRow('|:---|---:|:--:|')).toBe(true);
    expect(isDelimiterRow('| a | b |')).toBe(false);
  });
});

describe('unit · what is not a table', () => {
  test('a fenced block holding pipes is left alone', () => {
    const text = ['```', '| not | a | table |', '| neither | is | this |', '```', ''].join('\n');
    expect(findings(text)).toEqual([]);
  });

  test('two tables in one page are judged separately', () => {
    const text = [table(), '| x | y | z |', '|---|---|---|', '| 1 | 2 | 3 |', ''].join('\n');
    expect(findings(text)).toEqual([]);
  });
});

describe('unit · this wiki', () => {
  /**
   * The live rule against the real tree, and the measurement that justifies the scanner: the naive
   * `split('|')` disagrees with the correct one on rows that are already correct. If that count
   * ever reaches zero the escaped-pipe case has left the wiki and this assertion has stopped
   * proving anything — which is why it is asserted, not commented.
   */
  test(
    'every table renders, and the rows a naive splitter would break on are many',
    async () => {
      const files = await readWiki(repoRoot());
      expect(files.length).toBeGreaterThan(20);
      expect(checkTables(files)).toEqual([]);

      const naiveDisagreements = files
        .flatMap((file) => file.text.split('\n'))
        .filter((line) => line.trim().startsWith('|') && line.includes('\\|'))
        .filter(
          (line) =>
            splitRow(line).length !==
            line
              .trim()
              .replace(/^\||\|$/g, '')
              .split('|').length,
        );
      expect(naiveDisagreements.length).toBeGreaterThanOrEqual(30);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
