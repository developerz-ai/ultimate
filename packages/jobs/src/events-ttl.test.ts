// A refusal names the knob the caller wrote. Both buses screened `toMs(publishOptions.ttl ??
// defaultTtl)` under the name `defaultTtl`, so `bus.publish(name, payload, { ttl: NaN })` was told
// to "pass a finite defaultTtl" — an instruction pointing at an option the caller never set, and
// at a constructor that is often not even in the same file. `steps.ts` names `timeout` for the
// same value shape; this is that rule, applied twice.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import type { PgExecutor } from './driver-pg';
import { createMemoryEventBus } from './events';
import { createPgEventBus } from './events-pg';

const executor: PgExecutor = {
  query<R>(): Promise<readonly R[]> {
    return Promise.resolve([] as readonly R[]);
  },
};

const fixOf = (thrown: unknown): string =>
  thrown instanceof UltimateError ? `${thrown.code} ${thrown.cause} ${thrown.fix}` : '';

const rejection = async (call: () => Promise<unknown>): Promise<unknown> => {
  try {
    await call();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
};

const thrownBy = (build: () => unknown): unknown => {
  try {
    build();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
};

describe('a ttl that is not a duration is refused under the name the caller used', () => {
  test('the memory bus names ttl for a publish-call ttl, never defaultTtl', async () => {
    const bus = createMemoryEventBus();
    const thrown = await rejection(() => bus.publish('invoice.paid', {}, { ttl: Number.NaN }));

    expect(thrown).toBeInstanceOf(UltimateError);
    expect(fixOf(thrown)).toContain('X_INVARIANT');
    // `not.toContain` is the load-bearing half: `ttl` is a SUBSTRING of `defaultTtl`, so an
    // assertion that only looked for `ttl` passes against the message that named the wrong knob.
    expect(fixOf(thrown)).not.toContain('defaultTtl');
    expect(fixOf(thrown)).toContain('ttl');
  });

  test('the pg bus names ttl too — one wire format, one refusal', async () => {
    const bus = createPgEventBus({ executor });
    const thrown = await rejection(() => bus.publish('invoice.paid', {}, { ttl: Number.NaN }));

    expect(thrown).toBeInstanceOf(UltimateError);
    expect(fixOf(thrown)).not.toContain('defaultTtl');
    expect(fixOf(thrown)).toContain('ttl');
  });

  test('a defaultTtl that is not a duration is refused where it was declared', () => {
    // At CONSTRUCTION, not on the first publish that happens to omit a ttl: the bus is built at
    // boot and a bad default that only fires later is a bad default that fires in production.
    for (const defaultTtl of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(fixOf(thrownBy(() => createMemoryEventBus({ defaultTtl })))).toContain('defaultTtl');
      expect(fixOf(thrownBy(() => createPgEventBus({ executor, defaultTtl })))).toContain(
        'defaultTtl',
      );
    }
  });

  test('an ordinary publish is unchanged, on both — the guard refuses durations, not events', async () => {
    // Non-vacuity. `'7d'`, an explicit ms number and the default all still reach `expiresAt`.
    const memory = createMemoryEventBus({ defaultTtl: '1h' });
    const withTtl = await memory.publish('invoice.paid', { id: 1 }, { ttl: '30s' });
    const withDefault = await memory.publish('invoice.paid', { id: 2 });
    expect(withTtl.expiresAt - withTtl.publishedAt).toBe(30_000);
    expect(withDefault.expiresAt - withDefault.publishedAt).toBe(3_600_000);

    // The pg bus sends the DURATION and the database does the arithmetic (`SQL_EVENT_PUBLISH`).
    const sent: unknown[][] = [];
    const recording: PgExecutor = {
      query<R>(_sql: string, params: readonly unknown[]): Promise<readonly R[]> {
        sent.push([...params]);
        return Promise.resolve([] as readonly R[]);
      },
    };
    const pg = createPgEventBus({ executor: recording, defaultTtl: 1_000 });
    await pg.publish('invoice.paid', { id: 3 });
    await pg.publish('invoice.paid', { id: 4 }, { ttl: '30s' });
    expect(sent.map((params) => params[4])).toEqual([1_000, 30_000]);
  });
});
