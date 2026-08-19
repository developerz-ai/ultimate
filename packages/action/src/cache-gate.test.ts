/**
 * Proves the post-commit bust degrades instead of raising: the handler has already committed
 * by the time `bustAfterCommit` runs, so a dead tier or an undeclared tag may cost stale
 * entries but may never reverse an action result the caller was already handed.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { CacheTag, CacheTier, TierInvalidation, TierName } from '@ultimat3/cache';
import {
  declareTags,
  isolateDeclaredTags,
  isolateTiers,
  registerTier,
  resetDeclaredTags,
  resetTiers,
  tag,
} from '@ultimat3/cache';
import { bustAfterCommit } from './cache-gate';

/** Records what the fan-out actually reached it with, so "nothing was cleared" is assertable. */
function recordingTier(name: TierName, onInvalidate?: () => void): CacheTier {
  return {
    name,
    get: () => Promise.resolve(undefined),
    set: () => Promise.resolve(),
    del: () => Promise.resolve(),
    invalidateTags(tags: readonly CacheTag[]): Promise<TierInvalidation> {
      onInvalidate?.();
      return Promise.resolve({ tier: name, keys: tags.map((value) => value.entity) });
    },
  };
}

// The per-test reset is this file's own — every case here registers its own tier. The pair below
// is what hands the process back what it was lent: a reset clears what a NEIGHBOUR registered, and
// the leak guard reports additions only, so that damage surfaces as a failure in an innocent file.
const restoreTiers = isolateTiers();
const restoreTags = isolateDeclaredTags();

afterEach(() => {
  resetTiers();
  resetDeclaredTags();
});

afterAll(() => {
  restoreTiers();
  restoreTags();
});

describe('the post-commit cache bust', () => {
  test('a bust that lands returns the report the fan-out produced', async () => {
    declareTags(['post']);
    let cleared = 0;
    registerTier(recordingTier('lru', () => cleared++));

    const report = await bustAfterCommit('publishPost', [tag('post', '1')]);

    expect(report?.tags).toEqual(['post:1']);
    expect(report?.errors).toEqual([]);
    expect(cleared).toBe(1);
  });

  test('an undeclared tag never reaches the caller — the write already committed', async () => {
    declareTags(['post']);
    let cleared = 0;
    registerTier(recordingTier('lru', () => cleared++));

    const report = await bustAfterCommit('publishPost', [tag('feed')]);

    // `undefined`, not a report: the fan-out refused outright, so nothing was cleared at all.
    expect(report).toBeUndefined();
    expect(cleared).toBe(0);
  });

  test('a malformed `invalidates` entry is absorbed, not rethrown while being logged', async () => {
    declareTags(['post']);
    // `invalidates: [cond ? tag.post : undefined]` is the authoring slip behind this: it throws
    // from the fan-out AND from any attempt to render it, so the guard has to survive both.
    const malformed = [undefined] as unknown as readonly CacheTag[];

    expect(await bustAfterCommit('publishPost', malformed)).toBeUndefined();
  });

  test('one dead tier is a report with errors, never a refusal', async () => {
    declareTags(['post']);
    registerTier({
      ...recordingTier('redis'),
      invalidateTags: () => Promise.reject(new Error('redis is down')),
    });
    registerTier(recordingTier('lru'));

    const report = await bustAfterCommit('publishPost', [tag('post')]);

    expect(report?.errors).toEqual([{ tier: 'redis', message: 'Error: redis is down' }]);
    // The tier that answered still cleared, and the caller still got a report to render.
    expect(report?.tiers.map((entry) => entry.tier)).toEqual(['lru']);
  });
});
