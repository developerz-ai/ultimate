// An action whose output is `undefined`, retried under a key. A store that keeps the answer as JSON
// (the Postgres store, `JSON.stringify(value ?? null)`) hands a replay back `null` — JSON has no
// `undefined` — and the output schema that accepted the first answer refused its replay.

import { describe, expect, test } from 'bun:test';
import { ctxOf, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import type { IdempotencyStore } from './idempotency';
import { memoryIdempotencyStore } from './idempotency-memory';
import { invoke } from './invoke';

/** The memory store with the Postgres store's resting form: the answer as JSON, `undefined` null. */
function jsonStore(): IdempotencyStore {
  const inner = memoryIdempotencyStore();
  return {
    scope: inner.scope,
    keepsRedaction: true,
    reserve: (key, hash) => inner.reserve(key, hash),
    settle: (key, value, id, redacted) =>
      inner.settle(key, JSON.parse(JSON.stringify(value ?? null)) as unknown, id, redacted),
    fail: (key, failure, id) => inner.fail(key, failure, id),
    release: (key, id) => inner.release(key, id),
    get: (key) => inner.get(key),
  };
}

let runs = 0;
const touch = (output: Parameters<typeof action>[0]['output']) =>
  action({
    input: t.object({ id: t.string }),
    output,
    policy: allow(),
    idempotent: true,
    handle: () => {
      runs += 1;
      return undefined;
    },
  }).named('touchDoc');

const options = (store: IdempotencyStore) =>
  ({ ctx: ctxOf({ actor: userActor({ id: 'u1' }) }), store, idempotencyKey: 'K' }) as const;

describe('an undefined answer, replayed from a JSON store', () => {
  test('an undefined answer replays as undefined', async () => {
    runs = 0;
    const target = touch(t.object({ ok: t.boolean }).optional());
    const store = jsonStore();
    expect(await invoke(target, { id: 'd1' }, options(store))).toBeUndefined();
    expect(await invoke(target, { id: 'd1' }, options(store))).toBeUndefined();
    expect(runs).toBe(1);
  });

  test('a schema that accepts null still replays the stored null', async () => {
    runs = 0;
    const target = touch(t.object({ ok: t.boolean }).nullable().optional());
    const store = jsonStore();
    await invoke(target, { id: 'd1' }, options(store));
    expect(await invoke(target, { id: 'd1' }, options(store))).toBeNull();
    expect(runs).toBe(1);
  });
});
