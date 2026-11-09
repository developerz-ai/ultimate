// The read exercise spends from no bucket a later test reads: its runs count in a scratch store of
// their own, so the installed store — the one the same file's next call spends from — is untouched.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import type { RateLimitStore } from '@ultimat3/http';
import {
  installedRateLimitStore,
  installRateLimitStore,
  memoryRateLimitStore,
  resetRateLimitStore,
} from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { exerciseQuery } from './exercise';
import { query } from './query';
import { from } from './source';

beforeEach(() => resetRateLimitStore());
afterEach(() => resetRateLimitStore());

test('the exercise takes no token from the installed store', async () => {
  const keys: string[] = [];
  const memory = memoryRateLimitStore();
  const counting: RateLimitStore = {
    scope: memory.scope,
    take: (key, bucket, cost, nowMs) => {
      keys.push(key);
      return memory.take(key, bucket, cost, nowMs);
    },
    peek: (key, bucket, nowMs) => memory.peek(key, bucket, nowMs),
    reset: (key) => memory.reset(key),
  };
  installRateLimitStore(counting);
  const limited = query({
    input: t.object({ term: t.string.max(20) }),
    policy: allow(),
    rateLimit: { limit: 2, windowMs: 60_000 },
    sql: () => from<{ id: string }>('posts', [{ id: 'a' }]).limit(5),
  }).named('exRateFeed');
  await exerciseQuery(limited, { actor: userActor({ id: 'u1' }) });
  expect(installedRateLimitStore()).toBe(counting);
  expect(keys).toEqual([]);
});
