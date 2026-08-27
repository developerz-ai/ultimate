// `subscribes:` is the only way `x db gen` can learn which table a live read is patched from — the
// name lives inside `sql:`, a callback nothing can invoke without valid input (#357). A declaration
// an author hand-keeps in sync WILL drift, and a stale one grants REPLICA IDENTITY FULL to the
// wrong table while leaving the right one unpatchable, so the cross-check is the half under test.

import { beforeEach, describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { toLiveQuery } from './live';
import { describeQuery, query } from './query';
import { registerQuery, resetRegistry } from './registry';
import { from } from './source';

interface Post {
  readonly id: string;
  readonly orgId: string;
  readonly createdAt: number;
}

const ORG = '00000000-0000-4000-8000-000000000001';
const member = createContext({ actor: { ...userActor({ id: 'u1' }), permissions: ['feed:read'] } });
const posts: readonly Post[] = [{ id: 'a', orgId: ORG, createdAt: 10 }];

/** `subscribes` is spread so the "declares nothing" case is the SAME query minus one key. */
const defineFeed = (subscribes?: readonly string[]) =>
  query({
    input: t.object({ orgId: t.uuid }),
    policy: can('feed:read'),
    live: true,
    ...(subscribes === undefined ? {} : { subscribes }),
    sql: ({ orgId }) => from<Post>('posts', posts).where({ orgId }).orderBy('createdAt').limit(50),
  });

const thrownBy = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return expect.unreachable('the declaration was accepted');
};

describe('unit · a live read declares the relations it subscribes to', () => {
  beforeEach(() => {
    resetRegistry();
  });

  test('the declaration reaches the descriptor verbatim', () => {
    const feed = registerQuery('liveFeed', defineFeed(['posts']));

    expect(feed.subscribes).toEqual(['posts']);
    expect(feed.describe().subscribes).toEqual(['posts']);
  });

  test('a read that declares nothing describes as null and still subscribes', async () => {
    const feed = registerQuery('liveFeed', defineFeed());

    expect(feed.subscribes).toBeUndefined();
    expect(feed.describe().subscribes).toBeNull();
    const live = await toLiveQuery(feed, { orgId: ORG }, { ctx: member, epoch: 'build-1' });
    expect(live.shape.entity).toBe('posts');
  });

  test('a declaration that agrees with the resolved shape subscribes', async () => {
    const feed = registerQuery('liveFeed', defineFeed(['posts']));

    const live = await toLiveQuery(feed, { orgId: ORG }, { ctx: member, epoch: 'build-1' });
    expect(live.shape.entity).toBe('posts');
  });

  // A `QueryShape` names ONE relation, so a read joining others declares names this can never
  // resolve to. Extra names cost nothing — `@ultimat3/db` keeps only the ones an entity declares.
  test('naming more relations than the shape resolves to is accepted', async () => {
    const feed = registerQuery('liveFeed', defineFeed(['authors', 'posts']));

    const live = await toLiveQuery(feed, { orgId: ORG }, { ctx: member, epoch: 'build-1' });
    expect(live.shape.entity).toBe('posts');
  });
});

describe('unit · a declaration that disagrees with the read is refused', () => {
  beforeEach(() => {
    resetRegistry();
  });

  test('the resolved relation missing from the declaration refuses at subscribe', async () => {
    const feed = registerQuery('liveFeed', defineFeed(['post']));

    const thrown = await toLiveQuery(feed, { orgId: ORG }, { ctx: member, epoch: 'build-1' }).then(
      () => expect.unreachable('a stale declaration was accepted'),
      (error: unknown) => error,
    );

    expect(thrown).toBeUltimateError('X_QUERY_SUBSCRIBES_DRIFT');
    // Both names, because either one alone leaves the reader guessing which is wrong.
    const refusal = thrown as { cause: string; fix: string };
    expect(refusal.cause).toContain('post');
    expect(refusal.cause).toContain('posts');
    expect(refusal.fix).toContain('posts');
    expect(refusal.fix).toContain('x db gen');
  });

  test('an empty declaration is refused on the line that wrote it', () => {
    const thrown = thrownBy(() => defineFeed([]));

    expect(thrown).toBeUltimateError('X_QUERY_SUBSCRIBES_INVALID');
  });

  // The field is read for one purpose, and a read nobody can subscribe to never reaches the
  // cross-check — an unverifiable declaration is exactly the defect this whole slice closes.
  test('declaring relations for a read that is not live is refused', () => {
    const thrown = thrownBy(() =>
      query({
        input: t.object({ orgId: t.uuid }),
        policy: can('feed:read'),
        subscribes: ['posts'],
        sql: ({ orgId }) => from<Post>('posts', posts).where({ orgId }),
      }),
    );

    expect(thrown).toBeUltimateError('X_QUERY_SUBSCRIBES_INVALID');
    expect((thrown as { fix: string }).fix).toContain('live: true');
  });
});

// `build()` stores the def and `facadeFor()` exposes the same array, so without a frozen snapshot
// a caller could mutate the list AFTER `query()` validated it — and that list is what the manifest
// publishes and what `x db gen` grants REPLICA IDENTITY FULL from.
test('mutating the array after query() returns cannot change the descriptor', () => {
  const declared = ['posts'];
  const read = defineFeed(declared);
  registerQuery('liveFeed', read);

  declared.push('ghost');

  expect(describeQuery(read).subscribes).toEqual(['posts']);
});
