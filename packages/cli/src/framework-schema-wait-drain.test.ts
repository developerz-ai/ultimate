// SIGTERM while a schema READ is in flight — a catalog query on a blackholed database — ends the
// wait as a drain. Only the backoff sleep heard the drain's abort until 2026-11-16, so the boot sat
// on `check()` until the pool gave up (~125 s on a worker), past the pod's grace: SIGKILL, 137.

import { afterEach, describe, expect, test } from 'bun:test';
import { drain, frozenClock, isDraining, resetLifecycle, UltimateError } from '@ultimat3/core';
import type { SchemaCheck } from './framework-schema-wait';
import { waitForSchema } from './framework-schema-wait';
import { holdWhileBooting } from './hold';

afterEach(() => resetLifecycle());

/** A read that never answers, and a promise that resolves once the wait has issued it. */
function hungRead(): { readonly read: () => Promise<never>; readonly parked: Promise<void> } {
  let park: () => void = () => undefined;
  const parked = new Promise<void>((resolve) => {
    park = resolve;
  });
  return {
    read: () => {
      park();
      return new Promise<never>(() => undefined);
    },
    parked,
  };
}

const behind: SchemaCheck<string> = {
  ready: false,
  refuse: (waitedMs) =>
    new UltimateError({
      code: 'X_FRAMEWORK_SCHEMA_UNAPPLIED',
      cause: 'behind, in a test',
      fix: 'x db migrate',
      meta: { waitedMs: waitedMs ?? 0 },
    }),
};

const refusalOf = async (work: Promise<unknown>): Promise<UltimateError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof UltimateError) return error;
  }
  return expect.unreachable('the wait ended in a coded refusal');
};

describe('unit · a drain during an in-flight schema read', () => {
  test('a hung FIRST read ends with the drain, coded, before any verdict was read', async () => {
    const { read, parked } = hungRead();
    const waiting = refusalOf(waitForSchema(read, { deadlineMs: 300_000 }));
    await parked;
    await drain('SIGTERM');
    const error = await waiting;
    expect(error.code).toBe('X_DRAINING');
    expect(isDraining()).toBe(true);
  });

  // Round 3, P2-C: a SIGTERM landing while the boot still loads modules runs the drain's `accept`
  // phase before this wait registers its hook, so the abort was never heard and the first read
  // hung on an unreachable database past the pod's grace.
  test('a drain begun BEFORE the wait registers ends it at once, never reading', async () => {
    let reads = 0;
    const read = (): Promise<never> => {
      reads += 1;
      return new Promise<never>(() => undefined);
    };
    await drain('SIGTERM');
    const error = await refusalOf(waitForSchema(read, { deadlineMs: 300_000 }));
    expect(error.code).toBe('X_DRAINING');
    expect(reads).toBe(0);
  });

  test('a hung LATER read ends with the last verdict refused, as the sleep does', async () => {
    const { read, parked } = hungRead();
    let reads = 0;
    const check = (): Promise<SchemaCheck<string>> => {
      reads += 1;
      return reads === 1 ? Promise.resolve(behind) : read();
    };
    const clock = frozenClock();
    const waiting = refusalOf(waitForSchema(check, { deadlineMs: 300_000, clock }));
    await parked;
    await drain('SIGTERM');
    const error = await waiting;
    expect(error.code).toBe('X_FRAMEWORK_SCHEMA_UNAPPLIED');
    expect(reads).toBe(2);
    expect(error.meta?.['waitedMs']).toBe(clock.monotonic());
  });

  test('under the hold of a role, a hung read exits with the drain code, 0', async () => {
    const { read, parked } = hungRead();
    const exits: number[] = [];
    const booting = holdWhileBooting(
      'schema-wait',
      async () => {
        await waitForSchema(read, { deadlineMs: 300_000 });
        return { stop: async () => {} };
      },
      { exit: (code) => exits.push(code) },
    ).catch(() => undefined);
    await parked;
    await drain('SIGTERM');
    await booting;
    expect(exits).toEqual([0]);
  });

  test('a read that answers after the drain began is never waited on twice', async () => {
    let answer: (verdict: SchemaCheck<string>) => void = () => undefined;
    const pending = new Promise<SchemaCheck<string>>((resolve) => {
      answer = resolve;
    });
    const waiting = waitForSchema(() => pending, { deadlineMs: 300_000 });
    // Ready before any drain: the read's own answer wins, the wait serves it.
    answer({ ready: true, value: 'served' });
    expect(await waiting).toBe('served');
  });
});
