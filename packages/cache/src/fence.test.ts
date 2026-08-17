// The fence's whole job is to answer "did anything I am about to write get invalidated while I
// was loading it?" — so every test here samples first, invalidates second, and asks third. The
// ordering is explicit in the calls, never in a timer: the fence is synchronous by construction.

import { describe, expect, test } from 'bun:test';
import { FENCE_MEMORY, markInvalidated, sampleFence } from './fence';
import { tag } from './tags';

describe('sampleFence', () => {
  test('a fence with nothing invalidated under it is valid', () => {
    const fence = sampleFence({ key: 'post:1', tags: [tag('post', '1')] });
    expect(fence.isValid()).toBe(true);
  });

  test('an invalidation of the exact tag AFTER the sample invalidates it', () => {
    const fence = sampleFence({ key: 'post:1', tags: [tag('post', '1')] });
    markInvalidated({ tags: [tag('post', '1')] });
    expect(fence.isValid()).toBe(false);
  });

  test('an invalidation BEFORE the sample does not — the load already saw that write', () => {
    markInvalidated({ tags: [tag('post', '7')] });
    const fence = sampleFence({ tags: [tag('post', '7')] });
    expect(fence.isValid()).toBe(true);
  });

  test('a collection bust invalidates a row fence, and a row bust a collection fence', () => {
    const row = sampleFence({ tags: [tag('post', '2')] });
    markInvalidated({ tags: [tag('post')] });
    expect(row.isValid()).toBe(false);

    const collection = sampleFence({ tags: [tag('post')] });
    markInvalidated({ tags: [tag('post', '3')] });
    expect(collection.isValid()).toBe(false);
  });

  test('another entity, and another row of the same entity, leave it valid', () => {
    // Over-invalidation is not free: every fence it trips is a fill skipped and an origin read
    // the next request pays for, so the match is `tagMatches`, never "something happened".
    const fence = sampleFence({ tags: [tag('post', '4')] });
    markInvalidated({ tags: [tag('user', '4')] });
    markInvalidated({ tags: [tag('post', '5')] });
    expect(fence.isValid()).toBe(true);
  });

  test('a key drop invalidates a fence over that key, and only that key', () => {
    const fence = sampleFence({ key: 'post:1' });
    markInvalidated({ key: 'post:2' });
    expect(fence.isValid()).toBe(true);
    markInvalidated({ key: 'post:1' });
    expect(fence.isValid()).toBe(false);
  });

  test('cover() widens the fence RETROACTIVELY, back to when it was sampled', () => {
    // A joiner arriving mid-load declares tags the leader never sampled. Covering them has to
    // reach back, or the joiner's tag is unfenced for exactly the window it was absent.
    const fence = sampleFence({ key: 'feed' });
    markInvalidated({ tags: [tag('post', '9')] });
    expect(fence.isValid()).toBe(true);
    fence.cover({ tags: [tag('post', '9')] });
    expect(fence.isValid()).toBe(false);
  });

  test('an empty scope records nothing — a bust of no tags invalidates no fence', () => {
    const fence = sampleFence({ key: 'k', tags: [tag('post')] });
    markInvalidated({ tags: [] });
    expect(fence.isValid()).toBe(true);
  });

  test('a fence older than the ring can remember answers INVALID, never "probably fine"', () => {
    const fence = sampleFence({ tags: [tag('post', '1')] });
    for (let i = 0; i <= FENCE_MEMORY; i += 1)
      markInvalidated({ tags: [tag('unrelated', String(i))] });
    // Nothing matching was busted, but the ring can no longer prove that: the conservative
    // answer costs one refetch, the optimistic one serves a stale row for the whole TTL.
    expect(fence.isValid()).toBe(false);
  });
});
