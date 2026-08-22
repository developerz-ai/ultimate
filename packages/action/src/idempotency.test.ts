import { describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import type { Actor as PolicyActor } from '@ultimat3/policy';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { MemoryIdempotencyStore } from './idempotency-memory';
import { invoke } from './invoke';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ id: t.uuid, runs: t.number });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';
// `permissions` — direct grants, bypassing roles — is a field of POLICY's actor
// (`CoreActor & PolicyActorFields`), which is what `can()` reads through `actorHas`. Core's
// `Actor` has none and cannot: core is tier 0 and knows nothing about grants.
const editorActor: PolicyActor = { ...userActor({ id: 'u1' }), permissions: ['post:publish'] };
const ctx = createContext({ actor: editorActor });
/** A second editor: same permission, same key, and none of the first one's records. */
const bob: PolicyActor = { ...userActor({ id: 'u2' }), permissions: ['post:publish'] };
const bobCtx = createContext({ actor: bob });

function defineCounter() {
  let runs = 0;
  const target = action({
    input: Input,
    output: Output,
    policy: can('post:publish'),
    idempotent: true,
    async handle({ input }) {
      runs += 1;
      return { id: input.postId, runs };
    },
  }).named('publishPost');
  return { target, runs: () => runs };
}

describe('idempotency', () => {
  test('a replayed key returns the first response and does not re-run', async () => {
    const { target, runs } = defineCounter();
    const store = new MemoryIdempotencyStore();
    const options = { ctx, store, idempotencyKey: 'key-1' } as const;

    const first = await invoke(target, { postId: POST_ID }, options);
    const second = await invoke(target, { postId: POST_ID }, options);

    expect(second).toEqual(first);
    expect(runs()).toBe(1);
  });

  test('the same key with a different payload is X_IDEMPOTENCY_CONFLICT', async () => {
    const { target } = defineCounter();
    const store = new MemoryIdempotencyStore();
    await invoke(target, { postId: POST_ID }, { ctx, store, idempotencyKey: 'key-1' });

    const other = '00000000-0000-4000-8000-0000000000bb';
    const failure = await invoke(
      target,
      { postId: other },
      {
        ctx,
        store,
        idempotencyKey: 'key-1',
      },
    ).catch((error: unknown) => error);
    expect((failure as { code?: string }).code).toBe('X_IDEMPOTENCY_CONFLICT');
  });

  test('a concurrent duplicate is refused rather than run twice', async () => {
    const { target, runs } = defineCounter();
    const store = new MemoryIdempotencyStore();
    const options = { ctx, store, idempotencyKey: 'key-1' } as const;

    const [a, b] = await Promise.allSettled([
      invoke(target, { postId: POST_ID }, options),
      invoke(target, { postId: POST_ID }, options),
    ]);

    const outcomes = [a.status, b.status].sort();
    expect(outcomes).toEqual(['fulfilled', 'rejected']);
    expect(runs()).toBe(1);
  });

  test('without a key an idempotent action still runs every time', async () => {
    const { target, runs } = defineCounter();
    await invoke(target, { postId: POST_ID }, { ctx });
    await invoke(target, { postId: POST_ID }, { ctx });
    expect(runs()).toBe(2);
  });

  // A key was namespaced by ACTION NAME alone, so the record was shared by everyone who sent the
  // same header value: bob's `charge` replayed alice's stored response, and bob's *differing*
  // payload got X_IDEMPOTENCY_CONFLICT — one caller could deny another every key they guessed.
  test("another actor's identical key is another record, not a replay of the first", async () => {
    const { target, runs } = defineCounter();
    const store = new MemoryIdempotencyStore();

    const first = await invoke(target, { postId: POST_ID }, { ctx, store, idempotencyKey: 'k1' });
    const second = await invoke(
      target,
      { postId: POST_ID },
      { ctx: bobCtx, store, idempotencyKey: 'k1' },
    );

    expect(runs()).toBe(2);
    expect(second).not.toEqual(first);
  });

  test("another actor's differing payload cannot deny a key it does not own", async () => {
    const { target } = defineCounter();
    const store = new MemoryIdempotencyStore();
    await invoke(target, { postId: POST_ID }, { ctx, store, idempotencyKey: 'k1' });

    const other = '00000000-0000-4000-8000-0000000000bb';
    const outcome = await invoke(
      target,
      { postId: other },
      { ctx: bobCtx, store, idempotencyKey: 'k1' },
    ).catch((error: unknown) => error);
    expect(outcome).toEqual({ id: other, runs: 2 });
  });

  // `Headers.get()` answers `''` for `Idempotency-Key:`, and `'' ?? null` is `''`, so a blank
  // header reached the store as a live key shared by every caller who sent one.
  test('a blank key is refused before the handler, not silently shared', async () => {
    const { target, runs } = defineCounter();
    const store = new MemoryIdempotencyStore();
    const failure = await invoke(
      target,
      { postId: POST_ID },
      { ctx, store, idempotencyKey: '' },
    ).catch((error: unknown) => error);

    expect((failure as { code?: string }).code).toBe('X_IDEMPOTENCY_KEY_INVALID');
    expect(runs()).toBe(0);
  });
});

/**
 * The fence the settlement statements lacked. A straggler from a reservation that has since been
 * reclaimed — the window expired, another caller re-reserved the key — used to overwrite the
 * record it no longer owned, so the next replay answered a request with a value from a different
 * one. The mirror of `@ultimat3/jobs`' `SQL_ACK`, whose `and state = 'running'` exists for this.
 */
describe('a settlement is fenced on the reservation still being in flight', () => {
  test('a late settle cannot overwrite a record another settlement already wrote', async () => {
    const store = new MemoryIdempotencyStore();
    const reservation = await store.reserve('k', 'hash');
    await store.settle('k', { runs: 1 }, reservation.record.id);
    await store.settle('k', { runs: 2 }, reservation.record.id);

    expect((await store.get('k'))?.value).toEqual({ runs: 1 });
  });

  test('a late failure cannot turn a settled record into a failed one', async () => {
    const store = new MemoryIdempotencyStore();
    const reservation = await store.reserve('k', 'hash');
    await store.settle('k', { runs: 1 }, reservation.record.id);
    await store.fail(
      'k',
      { code: 'X_OUTPUT_INVALID', cause: 'late', fix: 'send a fresh Idempotency-Key header' },
      reservation.record.id,
    );

    const record = await store.get('k');
    expect(record?.status).toBe('settled');
    expect(record?.value).toEqual({ runs: 1 });
  });

  test('the first settlement of an in-flight reservation still lands', async () => {
    const store = new MemoryIdempotencyStore();
    const reservation = await store.reserve('k', 'hash');
    await store.settle('k', { runs: 1 }, reservation.record.id);

    expect((await store.get('k'))?.status).toBe('settled');
  });
});

/**
 * The case the status fence alone cannot see, and the reason `settle` carries a reservation id.
 * A first attempt whose window lapsed has its key reclaimed by the next caller, so the record is
 * `in-flight` AGAIN — belonging to someone else. A straggler from the first attempt satisfied the
 * status fence exactly, overwrote the replacement's live reservation, and the replacement's own
 * settle was then fenced out: the retry replayed a value produced for a different request.
 */
describe('a settlement is fenced on the reservation that produced it', () => {
  /** Two reservations for one key: the first expires, the second reclaims it. */
  const reclaimed = async (): Promise<{
    store: MemoryIdempotencyStore;
    first: string;
    second: string;
  }> => {
    let clock = 1_000;
    const store = new MemoryIdempotencyStore({ windowMs: 50, now: () => clock });
    const first = await store.reserve('k', 'hash');
    clock += 100;
    const second = await store.reserve('k', 'hash');
    expect(second.created).toBe(true);
    expect(second.record.id).not.toBe(first.record.id);
    return { store, first: first.record.id, second: second.record.id };
  };

  test('a straggler cannot settle a reservation it no longer owns', async () => {
    const { store, first, second } = await reclaimed();
    await store.settle('k', { from: 'first' }, first);

    const record = await store.get('k');
    expect(record?.status).toBe('in-flight');
    expect(record?.id).toBe(second);
  });

  test('the reservation that DOES own the record still settles', async () => {
    const { store, second } = await reclaimed();
    await store.settle('k', { from: 'second' }, second);

    expect((await store.get('k'))?.value).toEqual({ from: 'second' });
  });

  test("a straggler's FAILURE cannot fail a live reservation either", async () => {
    const { store, first, second } = await reclaimed();
    await store.fail(
      'k',
      { code: 'X_OUTPUT_INVALID', cause: 'late', fix: 'send a fresh Idempotency-Key header' },
      first,
    );

    const record = await store.get('k');
    expect(record?.status).toBe('in-flight');
    expect(record?.failure).toBeUndefined();
    expect(record?.id).toBe(second);
  });
});
