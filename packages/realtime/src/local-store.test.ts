// The tier-3 store's contract: journalled writes, ordered undo, key scoping — and the half that is
// new, that a table owns MEMBERSHIP while the shared identity map owns the VALUES, so an optimistic
// write and the live query rendering that row are one row rather than two copies of it.

import { describe, expect, test } from 'bun:test';
import { IdentityMap, rowKey } from './identity-map';
import type { Row } from './json';
import { createOpfsLocalStore, MemoryLocalStore } from './local-store';

type Post = Row & { readonly title: string; readonly likes: number };
type Tables = { posts: Post };

function store(): MemoryLocalStore<Tables> {
  return new MemoryLocalStore<Tables>({ posts: [{ id: 'p1', title: 'hello', likes: 1 }] });
}

describe('MemoryLocalStore', () => {
  test('a write inside apply is undone by rollback, newest first', () => {
    const local = store();
    local.apply('k1', (tx) => {
      tx.posts.update('p1', (post) => ({ likes: post.likes + 1 }));
      tx.posts.insert({ id: 'p2', title: 'new', likes: 0 });
    });

    expect(local.tx.posts.get('p1')?.likes).toBe(2);
    expect(local.pendingKeys()).toEqual(['k1']);

    local.rollback('k1');
    expect(local.tx.posts.get('p1')?.likes).toBe(1);
    expect(local.tx.posts.get('p2')).toBeUndefined();
    expect(local.pendingKeys()).toEqual([]);
  });

  test('commit drops the journal, so the write is no longer optimistic', () => {
    const local = store();
    local.apply('k1', (tx) => tx.posts.update('p1', () => ({ likes: 9 })));
    local.commit('k1');
    local.rollback('k1');

    expect(local.tx.posts.get('p1')?.likes).toBe(9);
  });

  test('only the first write to a row in one key is journalled — undo reaches the base state', () => {
    const local = store();
    local.apply('k1', (tx) => {
      tx.posts.update('p1', () => ({ likes: 2 }));
      tx.posts.update('p1', () => ({ likes: 3 }));
    });
    local.rollback('k1');

    expect(local.tx.posts.get('p1')?.likes).toBe(1);
  });

  test('a symbol on the tx resolves to nothing — awaiting one must not create a table', () => {
    const local = store();
    expect((local.tx as unknown as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined();
  });

  test('one apply is one notification, whatever it touched', () => {
    const local = store();
    const batches: number[] = [];
    local.identity.subscribe((changed) => batches.push(changed.size));

    local.apply('k1', (tx) => {
      tx.posts.update('p1', () => ({ likes: 2 }));
      tx.posts.insert({ id: 'p2', title: 'new', likes: 0 });
    });

    expect(batches).toEqual([2]);
  });

  test("the values are the shared map's, addressed by the entity name the live path uses", () => {
    const identity = new IdentityMap();
    const local = new MemoryLocalStore<Tables>({}, identity);
    local.apply('k1', (tx) => tx.posts.insert({ id: 'p1', title: 'hello', likes: 1 }));

    expect(identity.peek('posts', 'p1')).toEqual({ id: 'p1', title: 'hello', likes: 1 });
    expect(local.tx.posts.get('p1')).toBe(identity.peek('posts', 'p1') as Post);
  });

  test('a row a live window also holds survives the table dropping it', () => {
    const identity = new IdentityMap();
    const local = new MemoryLocalStore<Tables>({}, identity);
    // A live window holding the same row is the second hold — the client's real shape.
    identity.retain('posts', 'p1');

    local.apply('k1', (tx) => tx.posts.insert({ id: 'p1', title: 'h', likes: 1 }));
    local.rollback('k1');

    // Membership is gone, because the journal says the table did not hold it. The ROW is not gone,
    // because a window still holds it — an undo of an optimistic insert must not delete a row the
    // server sent in the meantime.
    expect(local.tx.posts.get('p1')).toBeUndefined();
    expect(identity.peek('posts', 'p1')).toEqual({ id: 'p1', title: 'h', likes: 1 });
  });

  test('reset releases what it held, so a reset store leaves no rows behind in the map', () => {
    const local = store();
    expect(local.identity.size).toBe(1);
    local.reset({});
    expect(local.identity.size).toBe(0);
    expect(local.snapshot('posts')).toEqual([]);
  });

  test('a table is keyed by name, and the key is what the map is keyed by too', () => {
    const local = store();
    expect(local.snapshot('posts')).toEqual([{ id: 'p1', title: 'hello', likes: 1 }]);
    expect(rowKey('posts', 'p1')).toContain('posts');
  });

  test('the OPFS store is a factory that refuses rather than a class the server can new', () => {
    expect(() => createOpfsLocalStore({ file: 'app.db', schemaVersion: 1 })).toThrow(
      /OPFS SQLite local store/,
    );
  });
});
