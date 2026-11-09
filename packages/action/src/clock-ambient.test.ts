// One clock: the memory idempotency store built with no `now` reads the installed clock at each
// call, so a record's timestamps follow `runtime.ts`'s clock and a test's frozen one.

import { expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { installClock } from '@ultimat3/core/adapter';
import { memoryIdempotencyStore } from './idempotency-memory';

test('a default-clock idempotency store stamps the installed clock', async () => {
  const store = memoryIdempotencyStore();
  const release = installClock(frozenClock('2001-02-03T04:05:06Z'));
  try {
    await store.reserve('clock-probe', 'fingerprint');
    const record = await store.get('clock-probe');
    expect(record?.createdAt).toBe(Date.parse('2001-02-03T04:05:06Z'));
  } finally {
    release();
  }
});
