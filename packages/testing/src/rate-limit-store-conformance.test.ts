// The conformance suite over the memory store, and the proof it can fail: a reset that drops every
// key (one caller's reset refills the fleet), and a peek that spends (a read that writes).

import { describe, expect, test } from 'bun:test';
import { memoryRateLimitStore } from '@ultimat3/http';
import type { RateLimitStore } from '@ultimat3/http/adapter';
import { RATE_LIMIT_STORE_CHECKS, rateLimitStoreConformance } from './rate-limit-store-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe(testName('unit', 'the memory rate-limit store'), () => {
  behavesLike(rateLimitStoreConformance, () => memoryRateLimitStore());
});

/** Every key forgotten on any reset — `delete from x_rate_limit` with the `where` dropped. */
const resetsEverything = (): RateLimitStore => {
  let inner = memoryRateLimitStore();
  return {
    scope: inner.scope,
    take: (key, bucket, cost, nowMs) => inner.take(key, bucket, cost, nowMs),
    peek: (key, bucket, nowMs) => inner.peek(key, bucket, nowMs),
    reset: async () => {
      inner = memoryRateLimitStore();
    },
  };
};

/** A peek implemented as a zero-refund take of one token: the read writes. */
const peekSpends = (): RateLimitStore => {
  const inner = memoryRateLimitStore();
  return {
    ...inner,
    scope: inner.scope,
    peek: async (key, bucket, nowMs) => {
      const decision = await inner.take(key, bucket, 1, nowMs);
      return { remaining: decision.remaining, retryAfterSeconds: decision.retryAfterSeconds };
    },
  };
};

const check = (name: string) => {
  const found = RATE_LIMIT_STORE_CHECKS.find((each) => each.name.startsWith(name));
  if (found === undefined) return expect.unreachable(`no conformance check named ${name}`);
  return found;
};

describe(testName('unit', 'a store that breaks the contract fails conformance'), () => {
  test('a reset that empties every key', async () => {
    const reset = check('reset empties one key');
    await expect(reset.run(resetsEverything())).rejects.toThrow();
    await reset.run(memoryRateLimitStore());
  });

  test('a peek that spends a token', async () => {
    const peek = check('peek spends nothing');
    await expect(peek.run(peekSpends())).rejects.toThrow();
    await peek.run(memoryRateLimitStore());
  });

  test('every check has a name of its own', () => {
    const names = RATE_LIMIT_STORE_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
