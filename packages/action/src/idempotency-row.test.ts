// A committed write answers its own retry. A delete's row is gone by the retry, so a row rule asked
// again judges `null` and refused the caller the answer it was owed. A finished record is that
// answer: the row half is skipped, the actor half never is.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, userActor } from '@ultimat3/core';
import type { Actor as PolicyActor } from '@ultimat3/policy';
import {
  can,
  definePermissions,
  knownPermissions,
  permissionDeclarationSites,
  restorePermissions,
} from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import type { IdempotencyStore } from './idempotency';
import { idempotencyKeyFor } from './idempotency-key';
import { memoryIdempotencyStore } from './idempotency-memory';
import { invoke } from './invoke';

// A foreign failure handed to the subject: test input, never its verdict.
const LANDED_THEN_THREW = new RangeError('the write landed, then the handler threw');

interface Doc {
  readonly owner: string;
}

let ambientPermissions: readonly string[] = [];
let ambientSites: Readonly<Record<string, readonly string[]>> = {};

beforeAll(() => {
  ambientPermissions = knownPermissions();
  ambientSites = permissionDeclarationSites();
  definePermissions(['doc:delete']);
});

afterAll(() => {
  restorePermissions(ambientPermissions, ambientSites);
});

const owner: PolicyActor = { ...userActor({ id: 'u1' }), permissions: ['doc:delete'] };
const revoked: PolicyActor = { ...userActor({ id: 'u1' }), permissions: [] };

let docs: Map<string, Doc>;
let runs = 0;
let loads = 0;

/** Built per test: `can()` validates its permission when the policy is built. */
const removeDoc = (handle?: () => void) =>
  action({
    input: t.object({ id: t.string }),
    output: t.object({ ok: t.boolean }),
    policy: can<{ id: string }, Doc>(
      'doc:delete',
      ({ actor, row }) => row !== null && row.owner === actor?.id,
    ),
    idempotent: true,
    row: ({ input }) => {
      loads += 1;
      return docs.get(input.id) ?? null;
    },
    handle: ({ input }) => {
      runs += 1;
      docs.delete(input.id);
      handle?.();
      return { ok: true };
    },
  }).named('removeDoc');

const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;

beforeEach(() => {
  docs = new Map([
    ['d1', { owner: 'u1' }],
    ['d2', { owner: 'u1' }],
  ]);
  runs = 0;
  loads = 0;
});

describe('a keyed delete with a row rule, retried', () => {
  test('the retry answers the stored value and runs nothing', async () => {
    const target = removeDoc();
    const store = memoryIdempotencyStore();
    const options = { ctx: ctxOf({ actor: owner }), store, idempotencyKey: 'K' } as const;

    expect(await invoke(target, { id: 'd1' }, options)).toEqual({ ok: true });
    expect(await invoke(target, { id: 'd1' }, options)).toEqual({ ok: true });
    expect(runs).toBe(1);
    // The row was not asked for: the rule it feeds has already had its say on this key.
    expect(loads).toBe(1);
  });

  test('a permission revoked between the two is refused, row or no row', async () => {
    const target = removeDoc();
    const store = memoryIdempotencyStore();
    await invoke(
      target,
      { id: 'd1' },
      { ctx: ctxOf({ actor: owner }), store, idempotencyKey: 'K' },
    );

    const retry = await invoke(
      target,
      { id: 'd1' },
      { ctx: ctxOf({ actor: revoked }), store, idempotencyKey: 'K' },
    ).catch((error: unknown) => error);
    expect(codeOf(retry)).toBe('X_FORBIDDEN');
    expect(runs).toBe(1);
  });

  test('the same key with another payload is a conflict, whatever that row holds', async () => {
    const target = removeDoc();
    const store = memoryIdempotencyStore();
    const options = { ctx: ctxOf({ actor: owner }), store, idempotencyKey: 'K' } as const;
    await invoke(target, { id: 'd1' }, options);

    const live = await invoke(target, { id: 'd2' }, options).catch((error: unknown) => error);
    expect(codeOf(live)).toBe('X_IDEMPOTENCY_CONFLICT');
    const gone = await invoke(target, { id: 'nope' }, options).catch((error: unknown) => error);
    expect(codeOf(gone)).toBe('X_IDEMPOTENCY_CONFLICT');
    expect(runs).toBe(1);
  });

  test('a first attempt that failed replays its failure, not a refusal of the row it removed', async () => {
    const target = removeDoc(() => {
      throw LANDED_THEN_THREW;
    });
    const store = memoryIdempotencyStore();
    const options = { ctx: ctxOf({ actor: owner }), store, idempotencyKey: 'K' } as const;
    await invoke(target, { id: 'd1' }, options).catch(() => undefined);

    const retry = await invoke(target, { id: 'd1' }, options).catch((error: unknown) => error);
    expect(codeOf(retry)).toBe('X_IDEMPOTENCY_REPLAYED_FAILURE');
    expect(runs).toBe(1);
  });
});

describe('where the row rule still decides', () => {
  test('no record yet: another owner is refused and the reservation is never made', async () => {
    docs.set('d3', { owner: 'someone-else' });
    const target = removeDoc();
    const store = memoryIdempotencyStore();
    const ctx = ctxOf({ actor: owner });

    const first = await invoke(target, { id: 'd3' }, { ctx, store, idempotencyKey: 'K' }).catch(
      (error: unknown) => error,
    );
    expect(codeOf(first)).toBe('X_FORBIDDEN');
    expect(runs).toBe(0);
    expect(await store.get(idempotencyKeyFor('removeDoc', 'K', ctx.actor))).toBeUndefined();
  });

  test('a duplicate in flight is judged by its row, as before', async () => {
    const target = removeDoc();
    const store = memoryIdempotencyStore();
    const ctx = ctxOf({ actor: owner });
    await store.reserve(idempotencyKeyFor('removeDoc', 'K', ctx.actor), 'hash');

    const refused = await invoke(target, { id: 'nope' }, { ctx, store, idempotencyKey: 'K' }).catch(
      (error: unknown) => error,
    );
    expect(codeOf(refused)).toBe('X_FORBIDDEN');
    expect(loads).toBe(1);
  });

  // The peek and the reservation are two calls: a record lapsing between them leaves a caller who
  // skipped the row rule holding a fresh reservation. The handler must not run on that skip.
  test('a settled record that lapses after the peek: the row rule runs before the handler', async () => {
    const target = removeDoc();
    const inner = memoryIdempotencyStore();
    const ctx = ctxOf({ actor: owner });
    const stored = idempotencyKeyFor('removeDoc', 'K', ctx.actor);
    const reservation = await inner.reserve(stored, 'hash');
    await inner.settle(stored, { ok: true }, reservation.record.id, false);
    const settled = await inner.get(stored);
    docs.set('d3', { owner: 'someone-else' });

    // Answers the peek from the settled record; the reservation behind it finds nothing.
    const fresh = memoryIdempotencyStore();
    const store: IdempotencyStore = {
      keepsRedaction: true,
      get: () => Promise.resolve(settled),
      reserve: (key, hash) => fresh.reserve(key, hash),
      settle: (key, value, id, redacted) => fresh.settle(key, value, id, redacted),
      release: (key, id) => fresh.release(key, id),
    };
    const refused = await invoke(target, { id: 'd3' }, { ctx, store, idempotencyKey: 'K' }).catch(
      (error: unknown) => error,
    );

    expect(codeOf(refused)).toBe('X_FORBIDDEN');
    expect(runs).toBe(0);
    // A refusal is not the key's outcome: the reservation it took is released, not settled.
    expect(await fresh.get(stored)).toBeUndefined();
  });
});
