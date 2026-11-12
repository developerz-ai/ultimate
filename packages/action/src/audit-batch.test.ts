// The group-commit wrapper: N concurrent audited calls are one `writeMany`, each `write()` settles
// with its own record — a rejected flush is retried singly, so one refused record fails one call and
// a dead store still fails every one — and a drain leaves nothing queued behind.

import { afterEach, describe, expect, jest, test } from 'bun:test';
import {
  configureLifecycle,
  ctxOf,
  drain,
  onShutdown,
  resetLifecycle,
  shutdownHookCount,
  userActor,
} from '@ultimat3/core';
import type { AuditRecord } from './audit';
import type { BatchAuditSink, BatchedAuditSink } from './audit-batch';
import { batchedAuditSink } from './audit-batch';

const recordNamed = (name: string): AuditRecord => ({
  at: new Date(1_700_000_000_000),
  name,
  primitive: 'action',
  mutator: true,
  surface: 'http',
  ctx: ctxOf({ actor: userActor({ id: 'u1' }) }),
  input: { postId: 'p1' },
  idempotencyKey: null,
  replayed: false,
  outcome: 'allowed',
  failure: null,
});

/** A batch sink that records each `writeMany` it was handed, and fails when told to. */
function recording(fail: () => unknown = () => undefined) {
  const batches: string[][] = [];
  const sink: BatchAuditSink = {
    write: (record) => sink.writeMany([record]),
    async writeMany(records) {
      batches.push(records.map((record) => record.name));
      const error = fail();
      if (error !== undefined) throw error;
    },
  };
  return { sink, batches };
}

const opened: BatchedAuditSink[] = [];
const open = (...args: Parameters<typeof batchedAuditSink>): BatchedAuditSink => {
  const sink = batchedAuditSink(...args);
  opened.push(sink);
  return sink;
};

afterEach(async () => {
  jest.useRealTimers();
  for (const sink of opened.splice(0)) await sink.close();
  resetLifecycle();
});

describe('batchedAuditSink groups concurrent writes into one writeMany', () => {
  test('three concurrent writes are ONE batch, and every write resolves', async () => {
    const { sink, batches } = recording();
    const batched = open(sink, { maxDelayMs: 0 });

    await Promise.all(['a', 'b', 'c'].map((name) => batched.write(recordNamed(name))));

    expect(batches).toEqual([['a', 'b', 'c']]);
  });

  test('maxRecords flushes at once, without waiting out the delay', async () => {
    jest.useFakeTimers();
    const { sink, batches } = recording();
    const batched = open(sink, { maxRecords: 2, maxDelayMs: 60_000 });

    const first = Promise.all([batched.write(recordNamed('a')), batched.write(recordNamed('b'))]);
    const third = batched.write(recordNamed('c'));
    await first;

    expect(batches).toEqual([['a', 'b']]);
    expect(batched.pending).toBe(1);
    jest.advanceTimersByTime(60_000);
    await third;
    expect(batches).toEqual([['a', 'b'], ['c']]);
  });

  test('a write waits for maxDelayMs, and not past it', async () => {
    jest.useFakeTimers();
    const { sink, batches } = recording();
    const batched = open(sink, { maxDelayMs: 50 });

    const write = batched.write(recordNamed('a'));
    jest.advanceTimersByTime(49);
    expect(batches).toEqual([]);
    jest.advanceTimersByTime(1);
    await write;
    expect(batches).toEqual([['a']]);
  });

  test('a rejected flush rejects EVERY waiter in that batch, with the sink’s own error', async () => {
    const refusal = new RangeError('the pool is gone');
    const { sink } = recording(() => refusal);
    const batched = open(sink, { maxDelayMs: 0 });

    const settled = await Promise.allSettled(
      ['a', 'b', 'c'].map((name) => batched.write(recordNamed(name))),
    );

    expect(settled.map((each) => each.status)).toEqual(['rejected', 'rejected', 'rejected']);
    for (const each of settled) {
      expect(each.status === 'rejected' ? each.reason : undefined).toBe(refusal);
    }
  });

  test('a sink that throws SYNCHRONOUSLY still rejects the waiters, never the timer', async () => {
    const refusal = new RangeError('sync');
    const sink: BatchAuditSink = {
      write: () => Promise.resolve(),
      writeMany: () => {
        throw refusal;
      },
    };
    const batched = open(sink, { maxDelayMs: 0 });

    await expect(batched.write(recordNamed('a'))).rejects.toBe(refusal);
  });

  test('one failed batch does not poison the next', async () => {
    let calls = 0;
    const { sink, batches } = recording(() => {
      calls += 1;
      return calls === 1 ? new RangeError('once') : undefined;
    });
    const batched = open(sink, { maxDelayMs: 0 });

    await expect(batched.write(recordNamed('a'))).rejects.toThrow('once');
    await batched.write(recordNamed('b'));
    expect(batches).toEqual([['a'], ['b']]);
  });

  test('one record the store refuses fails ITS call alone: the batch is retried one by one', async () => {
    const refusal = new RangeError('22P05: unsupported Unicode escape sequence');
    const singles: string[] = [];
    const sink: BatchAuditSink = {
      async write(record) {
        singles.push(record.name);
        if (record.name === 'poisoned') throw refusal;
      },
      async writeMany(records) {
        if (records.some((record) => record.name === 'poisoned')) throw refusal;
      },
    };
    const batched = open(sink, { maxDelayMs: 0 });

    const settled = await Promise.allSettled(
      ['a', 'poisoned', 'c'].map((name) => batched.write(recordNamed(name))),
    );

    expect(settled.map((each) => each.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(settled[1]?.status === 'rejected' ? settled[1].reason : undefined).toBe(refusal);
    expect(singles.toSorted()).toEqual(['a', 'c', 'poisoned']);
  });

  test('writeMany through the wrapper splits at maxRecords and resolves when all have', async () => {
    const { sink, batches } = recording();
    const batched = open(sink, { maxRecords: 2, maxDelayMs: 0 });

    await batched.writeMany(['a', 'b', 'c'].map(recordNamed));

    expect(batches).toEqual([['a', 'b'], ['c']]);
  });
});

describe('batchedAuditSink leaves nothing queued behind', () => {
  test('flush() sends what is queued and waits for it', async () => {
    jest.useFakeTimers();
    const { sink, batches } = recording();
    const batched = open(sink, { maxDelayMs: 60_000 });

    const write = batched.write(recordNamed('a'));
    await batched.flush();
    await write;

    expect(batches).toEqual([['a']]);
    expect(batched.pending).toBe(0);
  });

  test('a drain flushes the queue before the close phase', async () => {
    jest.useFakeTimers();
    configureLifecycle({ readinessGraceMs: 0 });
    let poolOpen = true;
    const { sink, batches } = recording(() =>
      poolOpen ? undefined : new RangeError('the pool closed first'),
    );
    const batched = open(sink, { maxDelayMs: 60_000 });
    // A pool registered AFTER the sink: the close phase runs in reverse, so it would close first.
    const closePool = onShutdown(
      'test.pool',
      () => {
        poolOpen = false;
      },
      { phase: 'close' },
    );

    const write = batched.write(recordNamed('a'));
    await drain('test');
    closePool();
    await write;

    expect(batches).toEqual([['a']]);
  });

  test('close() unregisters its drain hook, so a test or a re-boot does not leak one', async () => {
    const before = shutdownHookCount();
    const batched = batchedAuditSink(recording().sink);
    expect(shutdownHookCount()).toBe(before + 1);
    await batched.close();
    expect(shutdownHookCount()).toBe(before);
  });
});

describe('batchedAuditSink refuses a bound that is not one', () => {
  test.each([
    ['maxRecords', { maxRecords: 0 }],
    ['maxRecords', { maxRecords: Number.NaN }],
    ['maxDelayMs', { maxDelayMs: -1 }],
    ['maxDelayMs', { maxDelayMs: 1.5 }],
  ])('%s %p', (option, options) => {
    expect(() => batchedAuditSink(recording().sink, options)).toThrow(option);
  });
});
