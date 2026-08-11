// The union behind every `merge: 'json'` file. The shape that matters is a nested catalog: two
// generators contributing under one top-level key must both survive, and a translated leaf must
// never be replaced by the generator's English.

import { describe, expect, test } from 'bun:test';
import { mergeJsonDeep } from './json-merge';

describe('unit · mergeJsonDeep', () => {
  test('two contributors under one top-level key both survive — the shallow-spread bug', () => {
    const { merged, gained } = mergeJsonDeep(
      { app: { dashboard: { title: 'Dashboard' } } },
      { app: { post: { empty: 'No posts yet.' } } },
    );
    expect(merged).toEqual({
      app: { dashboard: { title: 'Dashboard' }, post: { empty: 'No posts yet.' } },
    });
    expect(gained).toBe(true);
  });

  test('a held leaf wins — it may be the human translation the generator would clobber', () => {
    const { merged, gained } = mergeJsonDeep(
      { site: { home: { title: 'Inicio' } } },
      { site: { home: { title: 'Home', cta: 'Open' } } },
    );
    expect(merged).toEqual({ site: { home: { title: 'Inicio', cta: 'Open' } } });
    expect(gained).toBe(true);
  });

  test('nothing new means gained is false, so a caller leaves the file untouched', () => {
    const held = { site: { home: { title: 'Inicio' } } };
    const { merged, gained } = mergeJsonDeep(held, { site: { home: { title: 'Home' } } });
    expect(gained).toBe(false);
    expect(merged).toEqual(held);
  });

  test('a branch meeting a leaf keeps the held shape rather than losing data either way', () => {
    expect(mergeJsonDeep({ site: 'literal' }, { site: { home: 'Home' } }).merged).toEqual({
      site: 'literal',
    });
    expect(mergeJsonDeep({ site: { home: 'Home' } }, { site: 'literal' }).merged).toEqual({
      site: { home: 'Home' },
    });
  });

  test('an array is a leaf, never merged element-wise', () => {
    const { merged } = mergeJsonDeep({ a: [1] }, { a: [2, 3] });
    expect(merged).toEqual({ a: [1] });
  });
});
