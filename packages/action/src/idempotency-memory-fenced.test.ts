// A fenced settlement is never thrown on the autocommit path, but an operator still has to see it:
// the value that attempt produced is stored nowhere. The Postgres store logs
// `action.idempotency.settlement-fenced`; the memory store must log the same line, or what an
// operator sees is whichever store the deployment happens to install.

import { afterEach, describe, expect, test } from 'bun:test';
import { setLogSink } from '@ultimat3/core';
import { memoryIdempotencyStore } from './idempotency-memory';

const KEY = '["chargeCard","user","u1",null,"k1"]';
const WINDOW_MS = 1_000;

let lines: string[] = [];
let previous: ReturnType<typeof setLogSink>;

afterEach(() => {
  setLogSink(previous);
  lines = [];
});

function capture(): void {
  previous = setLogSink((line) => {
    lines.push(line);
  });
}

/** A store whose first reservation is reclaimed past the window by a second one. */
async function reclaimed(): Promise<{
  readonly store: ReturnType<typeof memoryIdempotencyStore>;
  readonly straggler: string;
}> {
  let nowMs = 0;
  const store = memoryIdempotencyStore({ windowMs: WINDOW_MS, now: () => nowMs });
  const first = await store.reserve(KEY, 'h');
  nowMs = WINDOW_MS + 1;
  await store.reserve(KEY, 'h');
  return { store, straggler: first.record.id };
}

const fencedLines = (): string[] =>
  lines.filter((line) => line.includes('action.idempotency.settlement-fenced'));

describe('the memory store logs a fenced settlement — as the Postgres store does', () => {
  test('settle by a reclaimed reservation', async () => {
    const { store, straggler } = await reclaimed();
    capture();
    await store.settle(KEY, { charged: 'ch_1' }, straggler, false);
    expect(fencedLines()).toHaveLength(1);
    expect(fencedLines()[0]).toContain('settle');
    expect(fencedLines()[0]).toContain(straggler);
  });

  test('fail by a reclaimed reservation', async () => {
    const { store, straggler } = await reclaimed();
    capture();
    await store.fail(
      KEY,
      { code: 'X_DECLINED', cause: 'card declined', fix: 'use another card' },
      straggler,
    );
    expect(fencedLines()).toHaveLength(1);
    expect(fencedLines()[0]).toContain('fail');
  });

  test('an owned settle logs nothing', async () => {
    const store = memoryIdempotencyStore();
    const { record } = await store.reserve(KEY, 'h');
    capture();
    await store.settle(KEY, 1, record.id, false);
    expect(fencedLines()).toEqual([]);
  });
});
