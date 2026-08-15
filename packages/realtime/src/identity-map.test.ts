// The identity map's own rules: one value per `(scope, id)`, a write that changes nothing says
// nothing, a batch is one notification, and the last holder leaving takes the value with it.

import { describe, expect, test } from 'bun:test';
import { IdentityMap, privateScope, rowKey } from './identity-map';

function held(map: IdentityMap, scope: string, id: string): void {
  map.retain(scope, id);
}

describe('IdentityMap', () => {
  test('two scopes with the same id are two rows — an id alone is not an identity', () => {
    const map = new IdentityMap();
    held(map, 'posts', '7');
    held(map, 'users', '7');
    map.merge('posts', '7', { title: 'hello' });
    map.merge('users', '7', { email: 'a@b.c' });

    expect(map.peek('posts', '7')).toEqual({ id: '7', title: 'hello' });
    expect(map.peek('users', '7')).toEqual({ id: '7', email: 'a@b.c' });
  });

  test('merge adds columns and never removes one another projection is rendering', () => {
    const map = new IdentityMap();
    held(map, 'posts', 'p1');
    map.merge('posts', 'p1', { title: 'hello', body: 'long' });
    map.merge('posts', 'p1', { title: 'goodbye' });

    expect(map.peek('posts', 'p1')).toEqual({ id: 'p1', title: 'goodbye', body: 'long' });
  });

  test('every write is a NEW object — a mutated row is a render that never happens', () => {
    const map = new IdentityMap();
    held(map, 'posts', 'p1');
    const first = map.merge('posts', 'p1', { likes: 1 });
    const second = map.merge('posts', 'p1', { likes: 2 });

    expect(first).not.toBe(second);
    expect(first).toEqual({ id: 'p1', likes: 1 });
  });

  test('a merge that changes nothing keeps the identical object and notifies nobody', () => {
    const map = new IdentityMap();
    held(map, 'posts', 'p1');
    const seen: string[] = [];
    map.subscribe((changed) => seen.push(...changed));

    const first = map.merge('posts', 'p1', { likes: 1 });
    const again = map.merge('posts', 'p1', { likes: 1 });

    expect(again).toBe(first);
    expect(seen).toEqual([rowKey('posts', 'p1')]);
  });

  test('a batch is one notification carrying every key it touched', () => {
    const map = new IdentityMap();
    held(map, 'posts', 'p1');
    held(map, 'posts', 'p2');
    const batches: ReadonlySet<string>[] = [];
    map.subscribe((changed) => batches.push(changed));

    map.batch(() => {
      map.merge('posts', 'p1', { likes: 1 });
      map.merge('posts', 'p2', { likes: 2 });
      // A nested batch joins the open one rather than flushing early.
      map.batch(() => map.merge('posts', 'p1', { likes: 3 }));
    });

    expect(batches).toHaveLength(1);
    expect([...(batches[0] ?? [])].sort()).toEqual([rowKey('posts', 'p1'), rowKey('posts', 'p2')]);
  });

  test('the last holder leaving drops the value; an earlier one leaving does not', () => {
    const map = new IdentityMap();
    map.retain('posts', 'p1');
    map.retain('posts', 'p1');
    map.merge('posts', 'p1', { likes: 1 });

    map.release('posts', 'p1');
    expect(map.peek('posts', 'p1')).toEqual({ id: 'p1', likes: 1 });

    map.release('posts', 'p1');
    expect(map.peek('posts', 'p1')).toBeUndefined();
    expect(map.size).toBe(0);
  });

  test('releasing what was never held is a no-op, not a negative hold that leaks a row', () => {
    const map = new IdentityMap();
    map.release('posts', 'ghost');
    map.retain('posts', 'ghost');
    map.merge('posts', 'ghost', { likes: 1 });
    map.release('posts', 'ghost');

    expect(map.size).toBe(0);
  });

  test('`set` replaces the whole row, which is what a rollback undo needs', () => {
    const map = new IdentityMap();
    held(map, 'posts', 'p1');
    map.merge('posts', 'p1', { title: 'hello', draft: true });
    map.set('posts', { id: 'p1', title: 'hello' });

    expect(map.peek('posts', 'p1')).toEqual({ id: 'p1', title: 'hello' });
  });

  test('a private scope is one no entity name can spell, so it can never collide with one', () => {
    expect(privateScope('liveFeed')).toBe('?query:liveFeed');
    expect(privateScope('liveFeed').startsWith('?')).toBe(true);
  });
});
