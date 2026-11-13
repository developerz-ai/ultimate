// The static tag graph: writers, readers and routes grouped by a tag's entity half, sorted, and a
// tag read by something no action invalidates named as never evicted.

import { describe, expect, test } from 'bun:test';
import { cacheGraph, neverEvicted } from './cache-graph';

const source = {
  actions: [
    { name: 'publishPost', cacheInvalidates: ['post', 'feed'] },
    { name: 'editPost', cacheInvalidates: ['post:42'] },
    { name: 'noop', cacheInvalidates: [] },
  ],
  queries: [
    { name: 'postById', cacheTags: ['post'] },
    { name: 'planLimits', cacheTags: ['plan'] },
  ],
  routes: [{ url: '/blog', revalidateTags: ['post'] }, { url: '/' }],
};

describe('unit · cacheGraph', () => {
  test('one row per entity tag, its writers, readers and routes, sorted', () => {
    expect(cacheGraph(source)).toEqual([
      { tag: 'feed', writers: ['publishPost'], readers: [], routes: [] },
      { tag: 'plan', writers: [], readers: ['planLimits'], routes: [] },
      {
        tag: 'post',
        writers: ['editPost', 'publishPost'],
        readers: ['postById'],
        routes: ['/blog'],
      },
    ]);
  });

  test('a tag read and never written is never evicted; one written and never read is not', () => {
    const rows = cacheGraph(source);
    expect(rows.filter(neverEvicted).map((row) => row.tag)).toEqual(['plan']);
  });

  test('a tag named __proto__ is a row, not a prototype lookup', () => {
    const rows = cacheGraph({
      actions: [{ name: 'a', cacheInvalidates: ['__proto__'] }],
      queries: [],
      routes: [],
    });
    expect(rows).toEqual([{ tag: '__proto__', writers: ['a'], readers: [], routes: [] }]);
  });
});
