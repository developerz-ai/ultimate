// The gate rule that keeps `wiki/Knowledge-Base.md` honest as the agent retrieval index. Every
// negative case is a FIXTURE string — never an edit to a published page — and the positive case
// that matters most is the round-trip: a wiki page the rule lists is registered, and a registered
// page exists on disk. Anything that fails either half of the round-trip is a defect an agent
// will hit on the next retrieval query.

import { describe, expect, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
  checkWikiIndex,
  slugFromPath,
  type WikiIndexInput,
  wikiIndexFindingFor,
  wikiIndexGaps,
} from './wiki-index';

/** Wrap a list of `(path, text)` pairs in the input shape `checkWikiIndex` reads. */
const index = (...pairs: readonly (readonly [string, string])[]): WikiIndexInput => ({
  pages: pairs.map(([path, text]) => ({ path, text })),
  indexPage: pairs.find(([path]) => path === 'wiki/Knowledge-Base.md')?.[1],
});

describe('unit · slugFromPath', () => {
  test('a wiki file path becomes its slug', () => {
    expect(slugFromPath('wiki/Actions.md')).toBe('Actions');
  });

  test('a non-wiki path is not a slug', () => {
    expect(slugFromPath('packages/foo/README.md')).toBeUndefined();
    expect(slugFromPath('docs/idea/00-thesis.md')).toBeUndefined();
    expect(slugFromPath('wiki/')).toBeUndefined();
  });

  test('a non-md wiki path is not a slug', () => {
    expect(slugFromPath('wiki/Actions.mdx')).toBeUndefined();
  });
});

describe('unit · the rule, disk → page', () => {
  test('a page that exists on disk but not in the index is reported once', () => {
    const result = checkWikiIndex(
      index(
        [
          'wiki/Knowledge-Base.md',
          '## By topic\n\n| Topic | Page |\n|---|---|\n| Bar | [Bar](Bar) |\n',
        ],
        ['wiki/Foo.md', '# Foo\n'],
      ),
    );
    const missing = result.filter((gap) => gap.kind === 'unindexed');
    expect(missing).toEqual([{ kind: 'unindexed', page: 'wiki/Foo.md' }]);
  });

  test('a page that exists on disk AND in the index passes', () => {
    const result = checkWikiIndex(
      index(
        [
          'wiki/Knowledge-Base.md',
          '## By topic\n\n| Topic | Page |\n|---|---|\n| Foo | [Foo](Foo) |\n',
        ],
        ['wiki/Foo.md', '# Foo\n'],
      ),
    );
    expect(result).toEqual([]);
  });

  test('a partial is not flagged, even when the index does not list it', () => {
    const result = checkWikiIndex(
      index(
        ['wiki/Knowledge-Base.md', '## By topic\n\n'],
        ['wiki/_Footer.md', 'no heading on purpose'],
        ['wiki/_Sidebar.md', '### [Ultimate](Home)'],
      ),
    );
    expect(result).toEqual([]);
  });

  test('a link to a URL or path with a slash is not treated as a slug', () => {
    const result = checkWikiIndex(
      index(
        [
          'wiki/Knowledge-Base.md',
          '## By topic\n\n- [Foo](Foo)\n- [Bar](https://example.com/Bar)\n- [Baz](docs/idea/00-thesis)\n',
        ],
        ['wiki/Foo.md', '# Foo\n'],
      ),
    );
    expect(result).toEqual([]);
  });
});

describe('unit · the rule, page → disk', () => {
  test('a path in the **Every page, by path** table that no longer exists is reported once', () => {
    const result = checkWikiIndex(
      index(
        [
          'wiki/Knowledge-Base.md',
          [
            '## By topic',
            '',
            '| Topic | Page |',
            '|---|---|',
            '| Foo | [Foo](Foo) |',
            '',
            '## Every page, by path',
            '',
            '| Path | Slug | Topic |',
            '|---|---|---|',
            '| `wiki/Foo.md` | `Foo` | Foo |',
            '| `wiki/Ghost.md` | `Ghost` | Ghost |',
            '',
          ].join('\n'),
        ],
        ['wiki/Foo.md', '# Foo\n'],
      ),
    );
    const ghosts = result.filter((gap) => gap.kind === 'ghost');
    expect(ghosts).toEqual([{ kind: 'ghost', page: 'wiki/Ghost.md' }]);
  });

  test('every path that exists on disk passes the page → disk half', () => {
    const result = checkWikiIndex(
      index(
        [
          'wiki/Knowledge-Base.md',
          [
            '## By topic',
            '',
            '| Topic | Page |',
            '|---|---|',
            '| Foo | [Foo](Foo) |',
            '',
            '## Every page, by path',
            '',
            '| Path | Slug | Topic |',
            '|---|---|---|',
            '| `wiki/Foo.md` | `Foo` | Foo |',
            '',
          ].join('\n'),
        ],
        ['wiki/Foo.md', '# Foo\n'],
      ),
    );
    expect(result).toEqual([]);
  });
});

describe('unit · the index page itself', () => {
  test('an absent index is ONE finding, not one per page', () => {
    const result = checkWikiIndex({
      pages: [
        { path: 'wiki/Actions.md', text: '' },
        { path: 'wiki/Foo.md', text: '' },
      ],
      indexPage: undefined,
    });
    expect(result).toEqual([{ kind: 'absent', page: '' }]);
  });

  test('an absent index with no wiki pages at all is silent', () => {
    // A tree that ships no wiki owes no index — the same exemption `wiki-frames.ts` makes for an
    // empty `FRAME_KINDS`. Stating it here keeps the script callable from a synthetic root.
    const result = checkWikiIndex({ pages: [], indexPage: undefined });
    expect(result).toEqual([]);
  });
});

describe('unit · the finding carries the page it points at', () => {
  test('an unindexed page names itself in the `at`', () => {
    const finding = wikiIndexFindingFor({ kind: 'unindexed', page: 'wiki/Missing.md' });
    expect(finding.code).toBe('X_KNOWLEDGE_BASE_PAGE_MISSING');
    expect(finding.at).toBe('wiki/Missing.md');
    expect(finding.cause).toContain('wiki/Missing.md');
    expect(finding.fix).toContain('wiki/Missing.md');
  });

  test('a ghost path names itself in the `at`', () => {
    const finding = wikiIndexFindingFor({ kind: 'ghost', page: 'wiki/Ghost.md' });
    expect(finding.code).toBe('X_KNOWLEDGE_BASE_SLUG_STALE');
    expect(finding.at).toBe('wiki/Ghost.md');
  });

  test('an absent index names the index page, not the missing files', () => {
    const finding = wikiIndexFindingFor({ kind: 'absent', page: '' });
    expect(finding.code).toBe('X_KNOWLEDGE_BASE_PAGE_MISSING');
    expect(finding.at).toBe('wiki/Knowledge-Base.md');
  });
});

describe('unit · this wiki', () => {
  test(
    'every wiki page is registered in the index, and every path it names exists',
    async () => {
      const gaps = await wikiIndexGaps(repoRoot());
      expect(gaps).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
