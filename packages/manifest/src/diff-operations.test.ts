// A query's `subscribes` is what `x db gen` grants REPLICA IDENTITY FULL to, so a move here is a
// migration the release owes — and an unclassified field is a fact the gate cannot see, which is
// the failure `cacheTags` and nine other fields shipped as until 2026-08.

import { describe, expect, test } from 'bun:test';
import type { ManifestSources } from './build';
import { diffManifest } from './diff';
import { fixtureAction, fixtureManifest, fixtureQuery } from './diff-fixtures';

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

/**
 * `mutator` is what `sources.ts` writes for an action declared through `mutator()`, and no
 * `diff-*.ts` rule read it: two manifests differing only in an action losing it answered
 * `[{ kind: 'internal', path: 'buildId' }]` with `hasBreaking: false`, which is the exact failure
 * `cacheTags` and nine other fields shipped as.
 *
 * The direction is a decision, stated here so it can be argued with: a mutator is a CLIENT
 * CONTRACT capability, not a label — it decides the HTTP method and the idempotency the generated
 * client and the OpenAPI document publish — so an action that stops being one refuses callers
 * that were written against it (breaking), and one that becomes one refuses nobody (additive).
 */
describe('unit · an action that is a mutator says so', () => {
  type Action = NonNullable<ManifestSources['actions']>[number];

  const action = (overrides: Partial<Action>): readonly Action[] => [
    { ...fixtureAction('publishPost', 'post:publish'), ...overrides },
  ];

  const changesFor = (before: readonly Action[], after: readonly Action[]) =>
    diffManifest(fixtureManifest({ actions: before }), fixtureManifest({ actions: after }));

  test('losing the declaration is breaking', () => {
    const diff = changesFor(action({ mutator: true }), action({}));

    expect(diff.changes).toContainEqual({
      kind: 'breaking',
      path: 'actions.publishPost.mutator',
      detail: 'mutator true -> false',
    });
    expect(diff.hasBreaking).toBe(true);
  });

  test('gaining it is additive, and nothing that worked stops working', () => {
    const diff = changesFor(action({}), action({ mutator: true }));

    expect(diff.changes).toContainEqual({
      kind: 'additive',
      path: 'actions.publishPost.mutator',
      detail: 'mutator false -> true',
    });
    expect(diff.hasBreaking).toBe(false);
  });

  // The regression direction: absence is the shape `sources.ts` writes for a plain action, so a
  // rule that read it as a change would report every action in every app on every build.
  test('a declaration that did not move reports nothing, present or absent', () => {
    expect(changesFor(action({}), action({})).changes).toEqual([]);
    expect(changesFor(action({ mutator: true }), action({ mutator: true })).changes).toEqual([]);
  });
});

/** The tool description an agent reads. Visible in the file, absent from every contract. */
describe('unit · an MCP tool description', () => {
  test('a rewritten description is internal, never breaking', () => {
    const described = (
      description: string,
    ): readonly NonNullable<ManifestSources['actions']>[number][] => [
      { ...fixtureAction('publishPost', 'post:publish'), mcp: { expose: true, description } },
    ];
    const diff = diffManifest(
      fixtureManifest({ actions: described('Publish a draft post') }),
      fixtureManifest({ actions: described('Publish a post, notifying subscribers') }),
    );

    expect(diff.changes).toContainEqual({
      kind: 'internal',
      path: 'actions.publishPost.mcp.description',
      detail: 'description changed',
    });
    expect(diff.hasBreaking).toBe(false);
  });
});
