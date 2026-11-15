// A serving role over a schema still behind waits for the migrate step, bounded, saying so once —
// and is a drain, not a crash, when SIGTERM lands mid-wait. A database a newer MAJOR migrated is
// refused at once: no migrate of this build is coming.

import { afterEach, describe, expect, test } from 'bun:test';
import type { LogLevel, SleepClock } from '@ultimat3/core';
import {
  collectMetrics,
  drain,
  frameworkVersion,
  frozenClock,
  installLogSink,
  isDraining,
  recordFrameworkSchema,
  resetLifecycle,
  UltimateError,
} from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';
import { frameworkSchemaHash, nextStamp, type StampEntry } from './framework-schema-stamp';
import { verifySchema } from './framework-schema-verify';
import {
  DEFAULT_SCHEMA_WAIT_MS,
  SCHEMA_WAIT_ENV,
  schemaWaitMsFromEnv,
} from './framework-schema-wait';
import { holdWhileBooting } from './hold';

const mine: StampEntry = { version: frameworkVersion(), schema: frameworkSchemaHash() };
const majorOf = (version: string): number => Number(version.split('.')[0]);
const older: StampEntry = { version: `${majorOf(mine.version)}.0.0-old`, schema: '0'.repeat(16) };
const nextMajor: StampEntry = {
  version: `${majorOf(mine.version) + 1}.0.0`,
  schema: 'f'.repeat(16),
};

/**
 * A database whose stamp and ledger the test moves; `reads` counts the statements the role sent.
 * `applied: undefined` is a database with no `x_migrations`: a statement naming it fails `42P01`.
 */
function database(stamp: string | null, applied?: readonly string[]) {
  const state: { stamp: string | null; applied: readonly string[] | undefined; reads: number } = {
    stamp,
    applied,
    reads: 0,
  };
  const client: DbClient = {
    query: async <T>(fragment: { readonly text: string }) => {
      state.reads += 1;
      if (fragment.text.includes('x_migrations')) {
        if (state.applied === undefined)
          throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
        return [{ stamp: state.stamp, applied: JSON.stringify(state.applied) }] as unknown as T[];
      }
      return [{ stamp: state.stamp }] as unknown as T[];
    },
    one: () => expect.unreachable('verifySchema reads with query()'),
    execute: () => expect.unreachable('verifySchema runs no DDL'),
  };
  return { state, client };
}

interface Line {
  readonly level: LogLevel;
  readonly msg: string;
}

const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
  resetLifecycle();
});

function capture(): Line[] {
  const lines: Line[] = [];
  releases.push(
    installLogSink((line, level) => {
      lines.push({ level, msg: (JSON.parse(line) as { msg: string }).msg });
    }),
  );
  return lines;
}

const refusalOf = async (work: Promise<unknown>): Promise<UltimateError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof UltimateError) return error;
  }
  return expect.unreachable('the role was refused with a coded error');
};

describe('unit · a serving role waits for the migrate step', () => {
  test('behind, then applied mid-wait: the role serves, and said it waited exactly once', async () => {
    const lines = capture();
    const { state, client } = database(nextStamp(null, older));
    const clock = frozenClock();
    const sleeps: number[] = [];
    const watching: SleepClock = {
      ...clock,
      sleep: async (ms, signal) => {
        sleeps.push(ms);
        // The migrate Job lands during the fifth wait.
        if (sleeps.length === 5) state.stamp = nextStamp(state.stamp, mine);
        await clock.sleep(ms, signal);
      },
    };
    await verifySchema(client, { deadlineMs: 600_000, clock: watching, random: () => 0.5 });
    expect(state.reads).toBe(6);
    // Jittered and growing: equal jitter keeps half the curve as a floor.
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[3]).toBeGreaterThan(sleeps[0] ?? 0);
    const waiting = lines.filter((line) => line.msg === 'ultimate schema waiting');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.level).toBe('warn');
    expect(lines.filter((line) => line.msg === 'ultimate schema applied')).toHaveLength(1);
  });

  test('still behind at the deadline: refused with X_FRAMEWORK_SCHEMA_UNAPPLIED, never later', async () => {
    const lines = capture();
    const { state, client } = database(nextStamp(null, older));
    const clock = frozenClock();
    const error = await refusalOf(verifySchema(client, { deadlineMs: 120_000, clock }));
    expect(error.code).toBe('X_FRAMEWORK_SCHEMA_UNAPPLIED');
    expect(error.meta?.['waitedMs']).toBe(120_000);
    // The last wait is cut to the deadline, never slept past it.
    expect(clock.monotonic()).toBe(120_000);
    expect(state.reads).toBeGreaterThan(2);
    expect(lines.filter((line) => line.msg === 'ultimate schema waiting')).toHaveLength(1);
  });

  test('a database a newer major migrated is refused at once: no read after the first', async () => {
    const lines = capture();
    const { state, client } = database(nextStamp(null, nextMajor));
    const clock = frozenClock();
    const error = await refusalOf(verifySchema(client, { deadlineMs: 600_000, clock }));
    expect(error.code).toBe('X_FRAMEWORK_SCHEMA_UNAPPLIED');
    expect(error.meta?.['aheadByMajor']).toBe(true);
    expect(state.reads).toBe(1);
    expect(clock.monotonic()).toBe(0);
    expect(lines.filter((line) => line.msg === 'ultimate schema waiting')).toEqual([]);
  });

  /** A clock whose sleep only an abort ends; `parked` resolves once the role is waiting. */
  function blockingClock(): { readonly clock: SleepClock; readonly parked: Promise<void> } {
    const frozen = frozenClock();
    let park: (() => void) | undefined;
    const parked = new Promise<void>((resolve) => {
      park = resolve;
    });
    const clock: SleepClock = {
      ...frozen,
      sleep: (_ms, signal) =>
        new Promise<void>((_resolve, reject) => {
          park?.();
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    };
    return { clock, parked };
  }

  test('SIGTERM mid-wait ends the wait at once and leaves a drain, not a crash loop', async () => {
    const { client } = database(null);
    const { clock, parked } = blockingClock();
    const waiting = refusalOf(verifySchema(client, { deadlineMs: 600_000, clock }));
    await parked;
    await drain('SIGTERM');
    const error = await waiting;
    expect(error.code).toBe('X_FRAMEWORK_SCHEMA_UNAPPLIED');
    // `holdWhileBooting` reads this to exit `drainExitCode()` instead of rethrowing a crash.
    expect(isDraining()).toBe(true);
  });

  test('under the hold of a role, SIGTERM mid-wait exits with the drain code, 0', async () => {
    const { client } = database(null);
    const { clock, parked } = blockingClock();
    const exits: number[] = [];
    const booting = holdWhileBooting(
      'schema-wait',
      async () => {
        await verifySchema(client, { deadlineMs: 600_000, clock });
        return { stop: async () => {} };
      },
      { exit: (code) => exits.push(code) },
    ).catch(() => undefined);
    await parked;
    await drain('SIGTERM');
    await booting;
    expect(exits).toEqual([0]);
  });

  test('a deadline of 0 is the old refusal: one read, no wait, no line', async () => {
    const lines = capture();
    const { state, client } = database(null);
    const error = await refusalOf(verifySchema(client, { deadlineMs: 0, clock: frozenClock() }));
    expect(error.code).toBe('X_FRAMEWORK_SCHEMA_UNAPPLIED');
    expect(state.reads).toBe(1);
    expect(lines).toEqual([]);
  });

  test('an applied database is served on the first read, with no wait', async () => {
    const { state, client } = database(nextStamp(null, mine));
    await verifySchema(client, { deadlineMs: 600_000, clock: frozenClock() });
    expect(state.reads).toBe(1);
  });
});

describe(`unit · ${SCHEMA_WAIT_ENV}`, () => {
  test('unset or blank is the declared default', () => {
    expect(schemaWaitMsFromEnv({})).toBe(DEFAULT_SCHEMA_WAIT_MS);
    expect(schemaWaitMsFromEnv({ [SCHEMA_WAIT_ENV]: ' ' })).toBe(DEFAULT_SCHEMA_WAIT_MS);
  });

  test('whole milliseconds are read, 0 included', () => {
    expect(schemaWaitMsFromEnv({ [SCHEMA_WAIT_ENV]: '0' })).toBe(0);
    expect(schemaWaitMsFromEnv({ [SCHEMA_WAIT_ENV]: '90000' })).toBe(90_000);
  });

  test('the refusal fix is literal text naming the variable and its default', () => {
    let refused: unknown;
    try {
      schemaWaitMsFromEnv({ [SCHEMA_WAIT_ENV]: 'soon' });
    } catch (error) {
      refused = error;
    }
    expect(refused).toMatchObject({
      fix: expect.stringContaining(`${SCHEMA_WAIT_ENV}=${String(DEFAULT_SCHEMA_WAIT_MS)} `),
    });
  });

  test('anything else is X_CONFIG_INVALID, never a NaN deadline', () => {
    for (const bad of ['5m', '-1', '1.5', '0x10', '1e3']) {
      expect(() => schemaWaitMsFromEnv({ [SCHEMA_WAIT_ENV]: bad })).toThrow(
        expect.objectContaining({ code: 'X_CONFIG_INVALID' }),
      );
    }
  });
});

describe("unit · a serving role waits for the app's own migrations", () => {
  const shipped = ['0001_init', '0002_add_title'] as const;
  const stamped = nextStamp(null, mine);

  test('one statement per read, and served once the ledger holds every shipped migration', async () => {
    const lines = capture();
    const { state, client } = database(stamped, ['0001_init']);
    const clock = frozenClock();
    const sleeps: number[] = [];
    const watching: SleepClock = {
      ...clock,
      sleep: async (ms, signal) => {
        sleeps.push(ms);
        if (sleeps.length === 3) state.applied = [...shipped];
        await clock.sleep(ms, signal);
      },
    };
    await verifySchema(client, { deadlineMs: 600_000, clock: watching, shipped });
    expect(state.reads).toBe(4);
    expect(lines.filter((line) => line.msg === 'ultimate schema waiting')).toHaveLength(1);
    expect(lines.filter((line) => line.msg === 'ultimate schema applied')).toHaveLength(1);
  });

  test('still behind at the deadline: X_APP_MIGRATIONS_UNAPPLIED names what is missing', async () => {
    const { client } = database(stamped, ['0001_init']);
    const clock = frozenClock();
    const error = await refusalOf(verifySchema(client, { deadlineMs: 60_000, clock, shipped }));
    expect(error.code).toBe('X_APP_MIGRATIONS_UNAPPLIED');
    expect(error.meta?.['missing']).toEqual(['0002_add_title']);
    expect(error.meta?.['waitedMs']).toBe(60_000);
    expect(error.fix).toBe('x db migrate');
  });

  test('no ledger at all is behind, never a crash on 42P01: the stamp is read on its own', async () => {
    const { state, client } = database(stamped, undefined);
    const error = await refusalOf(
      verifySchema(client, { deadlineMs: 0, clock: frozenClock(), shipped }),
    );
    expect(error.code).toBe('X_APP_MIGRATIONS_UNAPPLIED');
    expect(error.meta?.['ledger']).toBe(false);
    expect(error.meta?.['missing']).toEqual([...shipped]);
    // The joint statement fails 42P01, then the stamp alone: the only case with a second read.
    expect(state.reads).toBe(2);
  });

  test('the framework stamp is judged first, from the same statement', async () => {
    const { state, client } = database(null, [...shipped]);
    const error = await refusalOf(
      verifySchema(client, { deadlineMs: 0, clock: frozenClock(), shipped }),
    );
    expect(error.code).toBe('X_FRAMEWORK_SCHEMA_UNAPPLIED');
    expect(state.reads).toBe(1);
  });

  test('a ledger ahead of the build (a rollback) is served, with one warning', async () => {
    const lines = capture();
    const { state, client } = database(stamped, [...shipped, '0003_add_body']);
    await verifySchema(client, { deadlineMs: 600_000, clock: frozenClock(), shipped });
    expect(state.reads).toBe(1);
    const ahead = lines.filter((line) => line.msg === 'ultimate app migrations ahead');
    expect(ahead).toHaveLength(1);
    expect(ahead[0]?.level).toBe('warn');
    expect(lines.filter((line) => line.msg === 'ultimate schema waiting')).toEqual([]);
  });

  test('a build that ships no migration never reads the ledger', async () => {
    const { client } = database(stamped, undefined);
    await verifySchema(client, { deadlineMs: 0, clock: frozenClock(), shipped: [] });
  });
});

describe('unit · the schema gauges a waiting role publishes', () => {
  const gaugeValue = (name: string): number | undefined =>
    collectMetrics().metrics.find((metric) => metric.descriptor.name === name)?.points[0]?.value;

  test('applied reads 0 during the wait and 1 once the migrate step lands', async () => {
    const { state, client } = database(nextStamp(null, older));
    const clock = frozenClock();
    const during: (number | undefined)[] = [];
    const watching: SleepClock = {
      ...clock,
      sleep: async (ms, signal) => {
        during.push(gaugeValue('framework_schema_applied'));
        if (during.length === 2) state.stamp = nextStamp(state.stamp, mine);
        await clock.sleep(ms, signal);
      },
    };
    await verifySchema(client, { deadlineMs: 600_000, clock: watching });
    expect(during).toEqual([0, 0]);
    expect(gaugeValue('framework_schema_applied')).toBe(1);
    expect(gaugeValue('framework_schema_major_skew')).toBe(0);
  });

  test('a newer major refused at once reads unapplied and skewed', async () => {
    const { client } = database(nextStamp(null, nextMajor));
    await refusalOf(verifySchema(client, { deadlineMs: 600_000, clock: frozenClock() }));
    expect(gaugeValue('framework_schema_applied')).toBe(0);
    expect(gaugeValue('framework_schema_major_skew')).toBe(1);
  });

  test('served across a major (this build stamped, a newer one newest) reads applied and skewed', async () => {
    const { client } = database(nextStamp(nextStamp(null, mine), nextMajor));
    await verifySchema(client, { deadlineMs: 0, clock: frozenClock() });
    expect(gaugeValue('framework_schema_applied')).toBe(1);
    expect(gaugeValue('framework_schema_major_skew')).toBe(1);
  });

  test('a build of a newer major waiting on an older stamp reads skewed too', async () => {
    const { client } = database(nextStamp(null, older));
    const ahead = { version: `${majorOf(mine.version) - 1}.9.0`, schema: '1'.repeat(16) };
    const { client: behindMajor } = database(nextStamp(null, ahead));
    await refusalOf(verifySchema(behindMajor, { deadlineMs: 0, clock: frozenClock() }));
    expect(gaugeValue('framework_schema_major_skew')).toBe(1);
    await refusalOf(verifySchema(client, { deadlineMs: 0, clock: frozenClock() }));
    expect(gaugeValue('framework_schema_major_skew')).toBe(0);
  });

  /** The gauge at each sleep of a wait, after it was set to 1 so an unrecorded read cannot pass. */
  async function gaugeDuringWait(
    client: DbClient,
    shipped: readonly string[],
    land: () => void,
  ): Promise<(number | undefined)[]> {
    recordFrameworkSchema({ applied: true, majorSkew: false });
    const clock = frozenClock();
    const during: (number | undefined)[] = [];
    const watching: SleepClock = {
      ...clock,
      sleep: async (ms, signal) => {
        during.push(gaugeValue('framework_schema_applied'));
        if (during.length === 2) land();
        await clock.sleep(ms, signal);
      },
    };
    await verifySchema(client, { deadlineMs: 600_000, clock: watching, shipped });
    return during;
  }

  test('no ledger at all: the stamp is still read and the gauge says unapplied', async () => {
    const { state, client } = database(null, undefined);
    const during = await gaugeDuringWait(client, ['0001_init'], () => {
      state.stamp = nextStamp(null, mine);
      state.applied = ['0001_init'];
    });
    expect(during).toEqual([0, 0]);
    expect(gaugeValue('framework_schema_applied')).toBe(1);
  });

  test('stamp current, app migrations pending: the gauge says unapplied for the whole wait', async () => {
    const { state, client } = database(nextStamp(null, mine), []);
    const during = await gaugeDuringWait(client, ['0001_init'], () => {
      state.applied = ['0001_init'];
    });
    expect(during).toEqual([0, 0]);
    expect(gaugeValue('framework_schema_applied')).toBe(1);
  });
});
