// Tags are the only invalidation currency in the framework, so their wire form is a protocol
// every tier and every CDN parses: one drifted separator and a purge matches nothing, silently.
// These tests pin that form, the match semantics fan-out depends on, and the unknown-tag refusal.

import { afterEach, describe, expect, test } from 'bun:test';
import { CacheTagUnknownError } from './errors';
import {
  assertKnownTags,
  declareTags,
  isolateDeclaredTags,
  knownTags,
  parseTag,
  resetDeclaredTags,
  serializeTag,
  serializeTags,
  tag,
  tagMatches,
  tagsFor,
  tagsIntersect,
} from './tags';

// `declared` is module-level global state — never let one test's declarations leak
// into the next, whether it ran in this file or another one sharing the process.
afterEach(() => {
  resetDeclaredTags();
});

describe('tag()', () => {
  test('produces a collection tag with no id', () => {
    expect(tag('post')).toEqual({ entity: 'post' });
  });

  test('produces a row tag when given an id', () => {
    expect(tag('post', '1')).toEqual({ entity: 'post', id: '1' });
  });

  test('property access is equivalent to calling tag() with no id', () => {
    expect(tag.post).toEqual(tag('post'));
    // Arbitrary keys must work: the Proxy has no fixed member list to fall back on.
    expect((tag as Record<string, unknown>).feed).toEqual({ entity: 'feed' });
  });
});

describe('serializeTag', () => {
  test('a collection tag serializes to just the entity name', () => {
    expect(serializeTag(tag('post'))).toBe('post');
  });

  test('a row tag serializes to entity:id', () => {
    expect(serializeTag(tag('post', '1'))).toBe('post:1');
  });
});

describe('parseTag', () => {
  test('round-trips a collection tag', () => {
    expect(parseTag('post')).toEqual({ entity: 'post' });
  });

  test('round-trips a row tag', () => {
    expect(parseTag('post:1')).toEqual({ entity: 'post', id: '1' });
  });

  test('splits on the first colon only, so a colon-bearing id is preserved whole', () => {
    expect(parseTag('post:abc:def')).toEqual({ entity: 'post', id: 'abc:def' });
  });
});

describe('serializeTags', () => {
  test('maps an array of tags to their wire forms', () => {
    expect(serializeTags([tag('post'), tag('post', '1'), tag('user', '9')])).toEqual([
      'post',
      'post:1',
      'user:9',
    ]);
  });
});

describe('tagsFor', () => {
  test('returns the collection tag and the row tag for a given entity + row', () => {
    expect(tagsFor({ name: 'post' }, { id: '1' })).toEqual([
      { entity: 'post' },
      { entity: 'post', id: '1' },
    ]);
  });
});

describe('tagMatches', () => {
  test('same entity, same id: matches', () => {
    expect(tagMatches(tag('post', '1'), tag('post', '1'))).toBe(true);
  });

  test('same entity, different id: does not match', () => {
    expect(tagMatches(tag('post', '1'), tag('post', '2'))).toBe(false);
  });

  test('requested has no id (collection request): matches any owned id', () => {
    expect(tagMatches(tag('post'), tag('post', '1'))).toBe(true);
  });

  test('owned has no id (owned is a collection): matches any requested id', () => {
    expect(tagMatches(tag('post', '1'), tag('post'))).toBe(true);
  });

  test('different entity: never matches, regardless of id', () => {
    expect(tagMatches(tag('post', '1'), tag('user', '1'))).toBe(false);
    expect(tagMatches(tag('post'), tag('user'))).toBe(false);
  });
});

describe('tagsIntersect', () => {
  test('true when any requested/owned pair matches', () => {
    expect(tagsIntersect([tag('post', '1')], [tag('user'), tag('post', '1')])).toBe(true);
  });

  test('false when no pair matches', () => {
    expect(tagsIntersect([tag('post', '1')], [tag('post', '2'), tag('user')])).toBe(false);
  });

  test('false when either side is empty', () => {
    expect(tagsIntersect([], [tag('post')])).toBe(false);
    expect(tagsIntersect([tag('post')], [])).toBe(false);
  });
});

describe('declareTags / knownTags / resetDeclaredTags', () => {
  test('declared entities appear sorted in knownTags()', () => {
    declareTags(['user', 'post']);
    expect(knownTags()).toEqual(['post', 'user']);
  });

  test('resetDeclaredTags empties the registry', () => {
    declareTags(['post']);
    resetDeclaredTags();
    expect(knownTags()).toEqual([]);
  });
});

describe('isolateDeclaredTags', () => {
  test('puts back exactly what it found, dropping only what was declared after it', () => {
    declareTags(['neighbour']);

    const restore = isolateDeclaredTags();
    declareTags(['mine']);
    expect(knownTags()).toEqual(['mine', 'neighbour']);
    restore();

    // The neighbour's declaration survives — which is what `resetDeclaredTags()` cannot promise
    // and why a suite reaches for this instead.
    expect(knownTags()).toEqual(['neighbour']);
  });

  test('restores a declaration a later reset dropped', () => {
    declareTags(['neighbour']);
    const restore = isolateDeclaredTags();

    resetDeclaredTags();
    restore();

    expect(knownTags()).toEqual(['neighbour']);
  });
});

describe('assertKnownTags', () => {
  test('passes silently when nothing has been declared yet', () => {
    expect(knownTags().length).toBe(0);
    expect(() => assertKnownTags([tag('anything')])).not.toThrow();
  });

  test('passes once a declared tag is asserted', () => {
    declareTags(['post']);
    expect(() => assertKnownTags([tag('post')])).not.toThrow();
  });

  test('throws CacheTagUnknownError for an undeclared tag once something is declared', () => {
    declareTags(['post']);
    expect(() => assertKnownTags([tag('pots')])).toThrow(CacheTagUnknownError);
  });
});
