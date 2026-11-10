// The gate rule that keeps `wiki/`'s tables renderable. Every negative case is a FIXTURE string —
// never an edit to a published page — and the positive case that matters most is the escaped pipe:
// a checker that fails on the 36 correct `\|` rows already in `wiki/` is worse than no checker,
// because the first thing an author does is "fix" the good row.

import { describe, expect, test } from 'bun:test';
// why: Bun has no temporary-directory or recursive-delete primitive of its own.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
  checkTables,
  isDelimiterRow,
  type MarkdownFile,
  readClaudeDocs,
  readWiki,
  splitRow,
  tableGapFindingFor,
  wikiTableFindings,
  wikiTableReport,
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

describe('unit · a run over no table is unscanned, never green', () => {
  test('no wiki page at all, or pages with no table in them, is X_WIKI_TABLE_UNSCANNED', () => {
    expect(wikiTableReport([]).map((one) => one.code)).toEqual(['X_WIKI_TABLE_UNSCANNED']);
    expect(wikiTableReport(page('# Home\n\nprose only\n')).map((one) => one.code)).toEqual([
      'X_WIKI_TABLE_UNSCANNED',
    ]);
    // A table inside a fence is not a rendered table, so it does not count as one read.
    expect(wikiTableReport(page('```\n| a |\n|---|\n```\n')).map((one) => one.code)).toEqual([
      'X_WIKI_TABLE_UNSCANNED',
    ]);
    expect(wikiTableReport([])[0]?.fix).toMatch(/^bun run scripts\/wiki-tables\.ts --json/);
  });

  test('a malformed row with no table read is reported as itself, not as unscanned', () => {
    // `| a | b |` with no delimiter is an orphan: zero tables counted, one gap with its own fix.
    expect(wikiTableReport(page('| a | b |\n')).map((one) => one.code)).toEqual([
      'X_WIKI_TABLE_MALFORMED',
    ]);
  });

  test('one well-formed table is a verdict: no finding', () => {
    expect(wikiTableReport(page(table()))).toEqual([]);
  });
});

describe('unit · CLAUDE.md tables are held to the same rule', () => {
  test('root and package CLAUDE.md are read; nothing else outside wiki/', async () => {
    const paths = (await readClaudeDocs(repoRoot())).map((file) => file.path);
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('packages/core/CLAUDE.md');
    expect(
      paths.every((path) => path === 'CLAUDE.md' || /^packages\/[^/]+\/CLAUDE\.md$/.test(path)),
    ).toBe(true);
  });

  test(
    'a planted collapsed or extra cell in a package CLAUDE.md is refused at its line',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'claude-tables-'));
      try {
        await mkdir(join(root, 'wiki'), { recursive: true });
        await mkdir(join(root, 'packages', 'fixture'), { recursive: true });
        await Bun.write(join(root, 'wiki', 'Home.md'), table());
        await Bun.write(join(root, 'CLAUDE.md'), table('| collapsed |'));
        await Bun.write(join(root, 'packages', 'fixture', 'CLAUDE.md'), table('| x | y | extra |'));
        const at = (await wikiTableFindings(root)).map((one) => `${one.code} ${one.at}`);
        expect(at).toEqual([
          'X_WIKI_TABLE_MALFORMED CLAUDE.md:4',
          'X_WIKI_TABLE_MALFORMED packages/fixture/CLAUDE.md:4',
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  test(
    'this repository: every CLAUDE.md table renders',
    async () => {
      expect(checkTables(await readClaudeDocs(repoRoot()))).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
