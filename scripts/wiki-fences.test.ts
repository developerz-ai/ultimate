// The wiki-fence ratchet: a page over its pin is the finding, a slack pin is its own finding, and a
// run that compiled nothing is a failure rather than a pass. The real tree is READ here, never
// compiled: `scripts/readme-fences.test.ts` compiles into the one fixture directory
// `scripts/lib/readme-fences.ts` owns, and two test files compiling into it at once would each
// delete the other's fixture. The compile itself runs on the gate's `manifest` step.

import { describe, expect, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import type { FenceFailure } from './readme-fences';
import {
  checkWikiFences,
  pageOf,
  pinnedWikiSource,
  readWikiFences,
  wikiFenceFinding,
} from './wiki-fences';
import { WIKI_FENCE_BACKLOG } from './wiki-fences-backlog';

const fail = (page: string, line: number): FenceFailure => ({
  pkg: page,
  readmeLine: line,
  reason: 'TS2304: Cannot find name.',
});

describe('the wiki-fence ratchet', () => {
  test('a page failing more examples than it is pinned at is the finding, naming the line', () => {
    const gaps = checkWikiFences(
      { pages: ['Actions'], failures: [fail('Actions', 12), fail('Actions', 40)] },
      { Actions: 1 },
    );
    expect(gaps.map((gap) => gap.kind)).toEqual(['over']);
    const finding = wikiFenceFinding(gaps[0] ?? expect.unreachable('no gap'));
    expect(finding.code).toBe('X_WIKI_EXAMPLE_UNCOMPILED');
    expect(finding.at).toBe('wiki/Actions.md:12');
    expect(finding.cause).toContain('line(s) 12, 40');
  });

  test('a page with no pin must compile — absent means zero', () => {
    const gaps = checkWikiFences({ pages: ['Money'], failures: [fail('Money', 3)] }, {});
    expect(gaps.map((gap) => gap.kind)).toEqual(['over']);
  });

  test('at the pin holds, and under it is a stale pin whose fix is one command', () => {
    expect(
      checkWikiFences({ pages: ['Money'], failures: [fail('Money', 3)] }, { Money: 1 }),
    ).toEqual([]);
    const [stale] = checkWikiFences({ pages: ['Money'], failures: [] }, { Money: 2 });
    const finding = wikiFenceFinding(stale ?? expect.unreachable('no gap'));
    expect(finding.code).toBe('X_WIKI_EXAMPLE_PIN_STALE');
    expect(finding.fix).toBe('bun run scripts/wiki-fences.ts --pin');
  });

  test('no fence anywhere, or a compiler that refused to run, is a failure, never a pass', () => {
    const none = checkWikiFences({ pages: [], failures: [] }, {});
    expect(none.map((gap) => wikiFenceFinding(gap).code)).toEqual(['X_WIKI_EXAMPLE_UNSCANNED']);
    const refused = checkWikiFences(
      { pages: ['Actions'], failures: [], unscanned: 'error TS5058' },
      {},
    );
    expect(wikiFenceFinding(refused[0] ?? expect.unreachable('no gap')).cause).toContain('TS5058');
  });

  test('--pin lowers a count, drops a zero, refuses to raise one, and writes Biome keys', () => {
    const source = [
      'export const WIKI_FENCE_BACKLOG: Readonly<Record<string, number>> = {',
      '  Actions: 3,',
      "  'Error-Codes': 2,",
      '  Money: 1,',
      '};',
    ].join('\n');
    const next = pinnedWikiSource(
      { Actions: 1, 'Error-Codes': 9 },
      { Actions: 3, 'Error-Codes': 2, Money: 1 },
      source,
    );
    expect(next).toContain('  Actions: 1,\n');
    expect(next).toContain("  'Error-Codes': 2,\n");
    expect(next).not.toContain('Money');
  });

  test('a page is named by its file stem, as the wiki links it', () => {
    expect(pageOf('wiki/Error-Codes.md')).toBe('Error-Codes');
  });
});

describe('against this repo', () => {
  test(
    'every pinned page exists and carries at least as many fences as it pins',
    async () => {
      const fences = await readWikiFences(repoRoot());
      expect(fences.length).toBeGreaterThan(100);
      for (const [page, pinned] of Object.entries(WIKI_FENCE_BACKLOG)) {
        const onPage = fences.filter((fence) => fence.pkg === page).length;
        expect({ page, enough: onPage >= pinned }).toEqual({ page, enough: true });
      }
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
