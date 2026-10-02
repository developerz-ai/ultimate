// The union behind every `merge: 'json'` file. The shape that matters is a nested catalog: two
// generators contributing under one top-level key must both survive, and a translated leaf must
// never be replaced by the generator's English.

import { describe, expect, test } from 'bun:test';
import { mergeJsonDeep, mergeJsonInPlace } from './json-merge';

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

describe('unit · mergeJsonInPlace: a generator run is a minimal diff', () => {
  const text = (value: unknown): string => JSON.stringify(value, null, 2);

  test('a file in its own hand-kept order keeps it: new keys go to the end of their level', () => {
    // The reference app's catalog is grouped by screen, not alphabetised. Re-sorting it on merge
    // was a 424-line diff for 22 added keys.
    const held = { nav: { home: 'Home', about: 'About' }, app: { zebra: 'Z', feed: 'Feed' } };
    const merged = mergeJsonInPlace(held, { app: { runs: 'Runs', apple: 'A' }, admin: { t: 'T' } });
    expect(text(merged)).toBe(
      text({
        nav: { home: 'Home', about: 'About' },
        app: { zebra: 'Z', feed: 'Feed', apple: 'A', runs: 'Runs' },
        admin: { t: 'T' },
      }),
    );
  });

  test('a level that IS sorted stays sorted: the new key takes its place', () => {
    // What `x g` itself writes is sorted, so two runs in either order still write the same bytes.
    const held = { admin: { title: 'T' }, app: { alpha: 'A', zebra: 'Z' } };
    const first = mergeJsonInPlace(mergeJsonInPlace(held, { app: { mid: 'M' } }), {
      api: { x: 'X' },
    });
    const second = mergeJsonInPlace(mergeJsonInPlace(held, { api: { x: 'X' } }), {
      app: { mid: 'M' },
    });
    expect(text(first)).toBe(
      text({ admin: { title: 'T' }, api: { x: 'X' }, app: { alpha: 'A', mid: 'M', zebra: 'Z' } }),
    );
    expect(text(second)).toBe(text(first));
  });

  test('sortedness is per level: an unsorted parent does not unsort a sorted child', () => {
    const held = { site: { a: '1', c: '3' }, app: { z: '26' } };
    expect(text(mergeJsonInPlace(held, { site: { b: '2' }, admin: { y: '25' } }))).toBe(
      text({ site: { a: '1', b: '2', c: '3' }, app: { z: '26' }, admin: { y: '25' } }),
    );
  });

  test('a held key always wins, and a wholly new subtree arrives sorted', () => {
    const held = { app: { title: 'Mine' } };
    const merged = mergeJsonInPlace(held, { app: { title: 'Generated' }, new: { b: '2', a: '1' } });
    expect(text(merged)).toBe(text({ app: { title: 'Mine' }, new: { a: '1', b: '2' } }));
  });

  test('nothing to add changes nothing, byte for byte', () => {
    const held = { nav: { home: 'Home', about: 'About' } };
    expect(text(mergeJsonInPlace(held, { nav: { about: 'X' } }))).toBe(text(held));
  });
});
