// The bust frame's codec, alone: what a sender writes and what any receiver, older or newer, reads.

import { describe, expect, test } from 'bun:test';
import { decodeBustFrame, encodeBustFrame, isFlushAll } from './runtime-cache-frame';

describe('unit · the bust frame', () => {
  test('no shared scope cleared: the bare tag array every older receiver already reads', () => {
    expect(encodeBustFrame(['post:1'])).toBe('["post:1"]');
    expect(encodeBustFrame(['post:1'], {})).toBe('["post:1"]');
  });

  test('a scope rides after the tags, and decodes back to both', () => {
    const frame = encodeBustFrame(['post:1', 'post'], { redis: 'x:v2' });
    expect(decodeBustFrame(JSON.parse(frame) as unknown[])).toEqual({
      wire: ['post:1', 'post'],
      sender: { redis: 'x:v2' },
    });
  });

  test('a frame with no scope object decodes to tags alone: every tier is busted', () => {
    expect(decodeBustFrame(['post:1'])).toEqual({ wire: ['post:1'] });
  });

  test('a malformed scope object is no scope at all', () => {
    for (const odd of [
      { scopes: null },
      { scopes: ['x'] },
      { scopes: { redis: 1 } },
      { other: 1 },
    ]) {
      expect(decodeBustFrame(['post:1', odd])).toEqual({ wire: ['post:1'] });
    }
  });

  test('the flush marker is an object with flush: all, and nothing else is', () => {
    expect(isFlushAll({ flush: 'all' })).toBe(true);
    expect(isFlushAll(['post:1', { scopes: { redis: 'x' } }])).toBe(false);
    expect(isFlushAll({ scopes: { redis: 'x' } })).toBe(false);
  });
});
