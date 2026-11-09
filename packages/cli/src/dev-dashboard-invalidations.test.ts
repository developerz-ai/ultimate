// The `/_x` cache panel's own history: newest first, bounded, stamped by its clock, and a copy —
// the cache keeps no ring buffer any more, so this subscriber is the only record a panel reads.

import { describe, expect, test } from 'bun:test';
import type { CacheInvalidateEvent } from '@ultimat3/core';
import { frozenClock, withSpan } from '@ultimat3/core';
import { createInvalidationLog } from './dev-dashboard-invalidations';

const bust = (tag: string): CacheInvalidateEvent => ({
  tags: [tag],
  busted: [`key:${tag}`],
  errors: [],
  durationMs: 1,
});

describe('unit · the /_x cache log', () => {
  test('newest first, capped at its limit', () => {
    const log = createInvalidationLog({ limit: 2 });
    for (const tag of ['a', 'b', 'c']) log.record(bust(tag));
    expect(log.facts().map((fact) => fact.tags[0])).toEqual(['c', 'b']);
  });

  test("stamped by its clock, sourced from the event's own source, never the span it runs in", () => {
    const clock = frozenClock('2026-11-09T10:00:00.000Z');
    const log = createInvalidationLog({ clock });
    // Recorded inside the cache's own span, as a subscriber is: that name must not become the source.
    withSpan('cache.invalidate', () => log.record({ ...bust('a'), source: 'action.publishPost' }));
    log.record(bust('b'));
    expect(log.facts()).toEqual([
      { at: '2026-11-09T10:00:00.000Z', tags: ['b'], busted: ['key:b'], source: 'cache' },
      {
        at: '2026-11-09T10:00:00.000Z',
        tags: ['a'],
        busted: ['key:a'],
        source: 'action.publishPost',
      },
    ]);
  });

  test('facts() is a copy and reset() empties it', () => {
    const log = createInvalidationLog();
    log.record(bust('a'));
    const facts = log.facts() as unknown[];
    facts.length = 0;
    expect(log.facts()).toHaveLength(1);
    log.reset();
    expect(log.facts()).toEqual([]);
  });
});
