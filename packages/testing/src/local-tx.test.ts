// `memoryLocalTx`: the store a mutator's `local()` half writes into under test. What it has to get
// right is what the page's record store gets right — keyed rows, merge-on-upsert, an update that
// invents nothing — because a twin proven against a store with other rules is proven against nothing.

import { describe, expect, test } from 'bun:test';
import { mutator, t } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
import { memoryLocalTx } from './local-tx';

interface Post {
  readonly id: string;
  readonly title: string;
  // `| undefined` on purpose: the cases below hand over an explicit `undefined`, which is the
  // value under test, and `exactOptionalPropertyTypes` refuses one for a bare `?:`.
  readonly likeCount?: number | undefined;
}

const KEY = 'post-1';
const seeded = () =>
  memoryLocalTx({ posts: { [KEY]: { id: KEY, title: 'before', likeCount: 4 } } });

describe('memoryLocalTx', () => {
  test('a seeded row is read by key, and a key nothing holds reads undefined', () => {
    const { tx } = seeded();
    expect(tx.table<Post>('posts').get(KEY)).toEqual({ id: KEY, title: 'before', likeCount: 4 });
    expect(tx.table<Post>('posts').get('absent')).toBeUndefined();
    expect(tx.table<Post>('posts').all()).toHaveLength(1);
  });

  test('update writes the changed fields and leaves the rest', () => {
    const store = seeded();
    store.tx.table<Post>('posts').update(KEY, { title: 'after' });
    expect(store.rows('posts')).toEqual({ [KEY]: { id: KEY, title: 'after', likeCount: 4 } });
  });

  test('update takes a function of the held row', () => {
    const store = seeded();
    store.tx.table<Post>('posts').update(KEY, (row) => ({ likeCount: (row.likeCount ?? 0) + 1 }));
    expect(store.rows<Post>('posts')[KEY]?.likeCount).toBe(5);
  });

  test('update is a no-op for a key the table does not hold: a twin invents no row', () => {
    const store = seeded();
    store.tx.table<Post>('posts').update('absent', { title: 'invented' });
    expect(Object.keys(store.rows('posts'))).toEqual([KEY]);
  });

  test('an undefined field in a patch leaves the column alone, in update and in upsert', () => {
    const store = seeded();
    const posts = store.tx.table<Post>('posts');
    posts.update(KEY, { title: 'after', likeCount: undefined });
    expect(store.rows<Post>('posts')[KEY]).toEqual({ id: KEY, title: 'after', likeCount: 4 });
    posts.upsert(KEY, { id: KEY, title: 'merged', likeCount: undefined });
    expect(store.rows<Post>('posts')[KEY]).toEqual({ id: KEY, title: 'merged', likeCount: 4 });
  });

  test('upsert stores a key the table has never seen, and insert replaces one it has', () => {
    const store = seeded();
    const posts = store.tx.table<Post>('posts');
    posts.upsert('post-2', { id: 'post-2', title: 'second' });
    posts.insert(KEY, { id: KEY, title: 'replaced' });
    expect(store.rows('posts')).toEqual({
      [KEY]: { id: KEY, title: 'replaced' },
      'post-2': { id: 'post-2', title: 'second' },
    });
  });

  test('delete removes the row', () => {
    const store = seeded();
    store.tx.table<Post>('posts').delete(KEY);
    expect(store.rows('posts')).toEqual({});
  });

  test('rows are frozen: a twin that mutates one in place throws instead of passing', () => {
    const store = seeded();
    const row = store.tx.table<{ title: string }>('posts').get(KEY);
    expect(() => {
      if (row !== undefined) row.title = 'in place';
    }).toThrow(TypeError);
    // And the seed is copied, never held: the caller's own object stays writable.
    const mine = { id: 'x', title: 'mine' };
    const copy = memoryLocalTx({ posts: { x: mine } });
    mine.title = 'still mine';
    expect(copy.rows<Post>('posts')['x']?.title).toBe('mine');
  });

  test('tx.<table> and tx.table(name) are one table; a table never seen holds nothing', () => {
    const store = seeded();
    const byName = store.tx.table<Post>('posts');
    const byProperty = (store.tx as unknown as { posts: typeof byName }).posts;
    byProperty.update(KEY, { title: 'through the property' });
    expect(byName.get(KEY)?.title).toBe('through the property');
    expect(store.rows('never-seen')).toEqual({});
    expect(memoryLocalTx().rows('posts')).toEqual({});
    // A symbol key is a runtime probe (`util.inspect`, a thenable check), never a table.
    expect((store.tx as unknown as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined();
  });

  test('a real mutator local half runs against it, and a replay lands where one run does', () => {
    const rename = mutator({
      input: t.object({ id: t.string, title: t.string }),
      output: t.object({ id: t.string }),
      policy: allow('public'),
      idempotent: true,
      local(tx, input) {
        tx.table<Post & { pending?: boolean }>('posts').update(input.id, {
          title: input.title,
          pending: true,
        });
      },
      async server(_ctx, input) {
        return { id: input.id };
      },
      conflict: 'server-wins',
    });
    const store = seeded();
    rename.local(store.tx, { id: KEY, title: 'renamed' });
    const once = store.rows('posts');
    expect(once).toEqual({ [KEY]: { id: KEY, title: 'renamed', likeCount: 4, pending: true } });
    rename.local(store.tx, { id: KEY, title: 'renamed' });
    expect(store.rows('posts')).toEqual(once);
  });
});
