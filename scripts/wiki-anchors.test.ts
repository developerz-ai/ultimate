// The wiki-anchor rule: a fragment lands on a heading slug GitHub would generate, a renamed heading
// is the finding with the nearest slug in its fix, and a run that read no link is not a pass.

import { describe, expect, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import type { WikiPage } from './wiki-anchors';
import {
  anchorLinksOf,
  anchorsOf,
  deadAnchorFinding,
  deadAnchors,
  readWikiPages,
  slugOf,
  wikiAnchorFindings,
} from './wiki-anchors';

const page = (name: string, ...lines: readonly string[]): WikiPage => ({
  page: name,
  text: lines.join('\n'),
});

describe('GitHub heading slugs', () => {
  test.each([
    ['Core and runtime', 'core-and-runtime'],
    ['`x verify` — the gate', 'x-verify--the-gate'],
    ['Feature slicing inside a surface', 'feature-slicing-inside-a-surface'],
    ['[Reserved](Error-Codes) codes', 'reserved-codes'],
    ['What `X_*` means?', 'what-x_-means'],
    ['Ünïcode stays', 'ünïcode-stays'],
  ])('%s → %s', (heading, slug) => {
    expect(slugOf(heading)).toBe(slug);
  });

  test('a repeated heading is numbered, a fenced one is not a heading, an <a id> is a target', () => {
    const anchors = anchorsOf(
      ['## Usage', '```md', '## Fenced', '```', '## Usage', '<a id="legacy-name"></a>'].join('\n'),
    );
    expect([...anchors].sort()).toEqual(['legacy-name', 'usage', 'usage-1']);
  });
});

describe('the links that are read', () => {
  test('Page#anchor, Page.md#anchor and #anchor; never a URL, a path out of the wiki or code', () => {
    const links = anchorLinksOf(
      page(
        'Home',
        'See [a](Actions#defining), [b](./Testing.md#unit), [c](#top).',
        '[ext](https://example.com/x#y) [doc](../docs/a.md#b) `[code](Actions#nope)`',
        '```',
        '[fenced](Actions#nope)',
        '```',
      ),
    );
    expect(links.map((link) => `${link.page}#${link.anchor}@${link.line}`)).toEqual([
      'Actions#defining@1',
      'Testing#unit@1',
      'Home#top@1',
    ]);
  });
});

describe('a dead anchor', () => {
  const pages = [
    page('Actions', '# Actions', '## Defining an action'),
    page('Home', '[x](Actions#defining-an-actoin) [y](Actions#defining-an-action) [z](Gone#a)'),
  ];

  test('is found, the live one is not', () => {
    expect(deadAnchors(pages).map((link) => `${link.page}#${link.anchor}`)).toEqual([
      'Actions#defining-an-actoin',
      'Gone#a',
    ]);
  });

  test('names the line, and its fix is the nearest slug on the target page', () => {
    const [typo, gone] = deadAnchors(pages);
    const finding = deadAnchorFinding(typo ?? expect.unreachable('no link'), pages);
    expect(finding.code).toBe('X_WIKI_ANCHOR_DEAD');
    expect(finding.at).toBe('wiki/Home.md:1');
    expect(finding.fix).toBe(
      'bun run scripts/wiki-anchors.ts --json   # then edit wiki/Home.md:1: replace #defining-an-actoin with #defining-an-action',
    );
    expect(deadAnchorFinding(gone ?? expect.unreachable('no link'), pages).cause).toContain(
      'there is no wiki/Gone.md',
    );
  });
});

describe('against this repo', () => {
  test(
    'every wiki anchor lands on a heading, over a non-vacuous read',
    async () => {
      const root = repoRoot();
      const pages = await readWikiPages(root);
      expect(pages.flatMap(anchorLinksOf).length).toBeGreaterThan(50);
      expect(await wikiAnchorFindings(root)).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
