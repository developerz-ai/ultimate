// A query's `subscribes` is what `x db gen` grants REPLICA IDENTITY FULL to, so a move here is a
// migration the release owes — and an unclassified field is a fact the gate cannot see, which is
// the failure `cacheTags` and nine other fields shipped as until 2026-08.

import { describe, expect, test } from 'bun:test';
import type { ManifestSources } from './build';
import { diffManifest } from './diff';
import { fixtureManifest, fixtureQuery } from './diff-fixtures';

type Query = NonNullable<ManifestSources['queries']>[number];

const withQuery = (overrides: Partial<Query>): readonly Query[] => [
  { ...fixtureQuery('feed', 'feed:read'), ...overrides },
];

const pathsFor = (queries: readonly Query[]): readonly string[] =>
  diffManifest(fixtureManifest(), fixtureManifest({ queries })).changes.map((c) => c.path);

describe('unit · a query reports the relations it subscribes to', () => {
  test('a relation swapped for another is reported as internal', () => {
    const changed = diffManifest(
      fixtureManifest(),
      fixtureManifest({ queries: withQuery({ subscribes: ['post'] }) }),
    );

    expect(changed.changes).toContainEqual({
      kind: 'internal',
      path: 'queries.feed.subscribes',
      detail: 'subscribed relations changed',
    });
    // Internal, never breaking: no caller's contract moved, and demanding a major for a table
    // grant would charge every app a release for a fact its readers never look at.
    expect(changed.hasBreaking).toBe(false);
  });

  test('dropping the declaration entirely is reported, not folded into "unchanged"', () => {
    const { subscribes: _dropped, ...noSubscribes } = fixtureQuery('feed', 'feed:read');

    expect(pathsFor([noSubscribes])).toContain('queries.feed.subscribes');
  });

  // The regression direction. A rule spelled `!==` over two arrays compares REFERENCES, so it
  // reports a change on every build; one spelled without a total reading of absence reports one on
  // every query that declares nothing — the state every shipped query is in today.
  test('a declaration that did not move reports nothing, present or absent', () => {
    const { subscribes: _dropped, ...noSubscribes } = fixtureQuery('feed', 'feed:read');

    expect(pathsFor(withQuery({}))).toEqual([]);
    expect(
      diffManifest(
        fixtureManifest({ queries: [noSubscribes] }),
        fixtureManifest({ queries: [noSubscribes] }),
      ).changes,
    ).toEqual([]);
  });
});
