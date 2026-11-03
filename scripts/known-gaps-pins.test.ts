// `known-gaps-pins.ts`: each rule against a page that breaks exactly it, then the committed page —
// the assertion that makes it a gate rather than a demo.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_URL, treeAt } from './known-gaps-links';
import type { PinTree } from './known-gaps-pins';
import { checkKnownGapPins, openRows, testTitled } from './known-gaps-pins';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Reads the real tree, so it runs on the repo-scan backstop — see `REPO_SCAN_TIMEOUT_MS`.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const PIN = `${REPO_URL}/blob/main/packages/x/src/a.test.ts`;
const TESTS = 'test(\'a purge waits for the ttl\', () => {});\nit("two", () => {});\n';
const tree: PinTree = { read: (path) => (path === 'packages/x/src/a.test.ts' ? TESTS : undefined) };

const page = (rows: readonly string[], decided: readonly string[] = []): string =>
  [
    '# Known gaps',
    '',
    '## Open',
    '',
    '| Gap | Symptom | Work around it by |',
    '|---|---|---|',
    ...rows,
    '',
    '## Open by decision',
    '',
    '| Gap | Why it stays |',
    '|---|---|',
    ...decided,
    '',
  ].join('\n');

const codes = (markdown: string, baseline: readonly string[] = []): readonly string[] =>
  checkKnownGapPins(markdown, tree, baseline).map((one) => `${one.code} ${one.at}`);

describe('an Open row', () => {
  test('pinned to a test that exists is clean, whichever quote the title uses', () => {
    const rows = [
      `| A | s [pin](${PIN}#a%20purge%20waits%20for%20the%20ttl) | w |`,
      `| B | s [pin](${PIN}#two) | w |`,
    ];
    expect(codes(page(rows))).toEqual([]);
  });

  test('with no pin is X_KNOWN_GAP_UNPINNED, at its line', () => {
    expect(codes(page(['| A | s | w |']))).toEqual(['X_KNOWN_GAP_UNPINNED wiki/Known-Gaps.md:7']);
  });

  test('pinned to a missing file, a missing test or a non-test file is unpinned', () => {
    const rows = [
      `| A | [pin](${REPO_URL}/blob/main/packages/x/src/gone.test.ts#two) | w |`,
      `| B | [pin](${PIN}#three) | w |`,
      `| C | [pin](${REPO_URL}/blob/main/packages/x/src/a.ts#two) | w |`,
      `| D | [pin](${PIN}) | w |`,
    ];
    expect(codes(page(rows))).toHaveLength(4);
  });

  test('`pin: none` with its reason needs no test; without a reason it is still unpinned', () => {
    expect(codes(page(['| A | one sighting, pin: none — never reproduced | w |']))).toEqual([]);
    expect(codes(page(['| A | pin: none | w |']))).toHaveLength(1);
  });

  test('an Open by decision row needs no pin', () => {
    expect(codes(page([], ['| D | why |']))).toEqual(['X_CORPUS_UNSCANNED wiki/Known-Gaps.md']);
  });
});

describe('the baseline', () => {
  test('a listed row may stay unpinned; one pinned since, or gone, is X_KNOWN_GAP_PIN_STALE', () => {
    expect(codes(page(['| A | s | w |']), ['A'])).toEqual([]);
    const pinned = page([`| A | [pin](${PIN}#two) | w |`]);
    expect(codes(pinned, ['A'])).toEqual(['X_KNOWN_GAP_PIN_STALE wiki/Known-Gaps.md:7']);
    expect(codes(page(['| B | s | w |']), ['A', 'B'])[0]).toStartWith('X_KNOWN_GAP_PIN_STALE');
  });
});

describe('parsing', () => {
  test('only the Open table, keyed by its first cell', () => {
    const rows = openRows(page(['| `x` **y** | s | w |'], ['| D | why |']));
    expect(rows.map((row) => row.key)).toEqual(['`x` **y**']);
  });

  test('a title is a test only as the first argument of test( or it(', () => {
    expect(testTitled("test.each([1])('n %d', () => {})", 'n %d')).toBe(true);
    expect(testTitled("describe('two', () => {})", 'two')).toBe(false);
    expect(testTitled("const name = 'two';", 'two')).toBe(false);
  });
});

describe('the committed wiki/Known-Gaps.md', () => {
  test('every Open row is pinned or on the baseline, and the baseline names only real rows', async () => {
    const root = repoRoot();
    const markdown = await Bun.file(`${root}/wiki/Known-Gaps.md`).text();
    expect(openRows(markdown).length).toBeGreaterThan(0);
    const { KNOWN_GAPS_UNPINNED } = await import('./lib/known-gaps-unpinned-pins');
    expect(checkKnownGapPins(markdown, treeAt(root), KNOWN_GAPS_UNPINNED)).toEqual([]);
  });
});
