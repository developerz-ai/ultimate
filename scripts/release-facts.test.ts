// The corpus states one fact five ways and means two different sets by it, so the cases that
// matter here are the ones where a number is legitimately ambiguous.

import { describe, expect, test } from 'bun:test';
import { checkReleaseFacts, foldStatPairs, releaseFacts, skipFactPath } from './release-facts';

const FACTS = releaseFacts([
  ...Array.from({ length: 29 }, (_, i) => `@ultimat3/p${String(i)}`),
  'create-ultimate',
]);

const gaps = (text: string, path = 'p.md'): readonly string[] =>
  checkReleaseFacts({ pages: [{ path, text }], facts: FACTS })
    .filter((gap) => gap.kind === 'stale')
    .map((gap) => gap.quote);

describe('the counts come from the workspace list', () => {
  test('29 scoped and 30 in all, derived and not written down', () => {
    expect(FACTS[0]?.accepts).toEqual([29]);
    expect(FACTS[1]?.accepts).toEqual([30]);
    expect(FACTS[2]?.accepts).toEqual([29, 30]);
  });
});

describe('exact phrasings', () => {
  test('a scoped count that is not the scoped count is stale', () => {
    expect(gaps('a monorepo of 27 `@ultimat3/*` packages')).toEqual(['27 `@ultimat3/*` packages']);
    expect(gaps('a monorepo of 29 `@ultimat3/*` packages')).toEqual([]);
  });

  test('the total, however the page spells it', () => {
    expect(gaps('30 in all — packages')).toEqual([]);
    expect(gaps('all 30 workspaces resolve')).toEqual([]);
    expect(gaps('28 tarballs')).toEqual(['28 tarballs']);
  });
});

describe('the ambiguous phrasings', () => {
  test('"all N packages" is correct for EITHER set, so both pass and neither hides a stale one', () => {
    // wiki/Upgrading.md means the total; wiki/FAQ.md means the scoped set. Both are right.
    expect(gaps('one release bumps all 30 packages')).toEqual([]);
    expect(gaps('All 29 packages, implemented and tested')).toEqual([]);
    expect(gaps('All 28 publish to npm')).toEqual(['All 28 publish']);
  });

  test('"N in all" about something that is not a package is left alone', () => {
    // wiki/The-Eight-Primitives.md counts the FILES in a generated slice this way.
    expect(gaps('an entity, a policy, a route — 25 in all')).toEqual([]);
  });
});

describe('history is not a stale claim', () => {
  test('a count attached to an older release is left alone', () => {
    expect(gaps('1.0.0 shipped the 28 packages, the docs and the three build targets')).toEqual([]);
    expect(gaps('up from 27 `@ultimat3/*` packages')).toEqual([]);
  });

  test('the changelog and the plan record are not read at all', () => {
    expect(skipFactPath('CHANGELOG.md')).toBe(true);
    expect(skipFactPath('docs/plans/2026/08/x.md')).toBe(true);
    expect(skipFactPath('README.md')).toBe(false);
  });
});

describe('the false green', () => {
  test('a corpus stating no count is a finding, not agreement', () => {
    const found = checkReleaseFacts({ pages: [{ path: 'p.md', text: 'no counts' }], facts: FACTS });
    expect(found.map((gap) => gap.kind)).toEqual(['vacuous']);
  });
});

describe('a stat strip states a count under two different JSON keys', () => {
  // The deployed demo rendered `29 packages published in lockstep` while the tree published 31,
  // and this rule could not see it. Widening the globs to JSON would NOT have been enough: the
  // number and the words it counts are on two different lines, and every pattern here matches a
  // number ADJACENT to its subject.
  const strip = [
    '{',
    '  "stats": {',
    '    "packages": {',
    '      "value": "27",',
    '      "label": "packages published in lockstep"',
    '    }',
    '  }',
    '}',
  ].join('\n');

  test('the pair is folded onto ONE line, and the line numbers do not move', () => {
    const folded = foldStatPairs(strip).split('\n');
    expect(folded).toHaveLength(strip.split('\n').length);
    expect(folded[3]).toBe('27 packages published in lockstep');
    // Blanked, not removed — a finding has to cite the line a human edits.
    expect(folded[4]).toBe('');
  });

  test('a folded stat strip with a wrong count is a stale claim', () => {
    expect(gaps(foldStatPairs(strip), 'en.json')).toEqual(['27 packages published']);
  });

  test('either honest reading of the phrasing is accepted', () => {
    // The words do not say WHICH set, so scoped and total are both correct English — this file's
    // own rule for an unqualified phrasing. 27 is neither, which is why the case above is caught.
    for (const honest of ['29', '30']) {
      const page = foldStatPairs(strip.replace('"27"', `"${honest}"`));
      expect(gaps(page, 'en.json')).toEqual([]);
    }
  });

  test('an unpaired value is not a claim', () => {
    // A `value` with no `label` under it counts nothing, and must not invent a subject for itself.
    const lonely = ['{', '  "value": "27",', '  "other": "x"', '}'].join('\n');
    expect(foldStatPairs(lonely)).toBe(lonely);
    expect(gaps(foldStatPairs(lonely), 'en.json')).toEqual([]);
  });
});
