// How `coverage-gate.ts --all` spends a runner's cores: how many `bun test` workers a unit gets, and
// the pool that never holds more cores than the runner has, whatever each unit leased.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  concurrency,
  FILES_PER_WORKER,
  leasePool,
  serviceKeys,
  UNIT_SECONDS,
  unitEnv,
  unitWeight,
  workersFor,
} from './coverage-schedule';
import { unitsToGate } from './coverage-units';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';
import { ScriptError } from './script-error';

// Two tests read the real tree (the unit list, the env file): a backstop, not an assertion.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

describe('how many workers one unit runs on', () => {
  test('a unit under one worker’s share of files runs in one process, exactly as before', () => {
    expect(workersFor(1, 4)).toBe(1);
    expect(workersFor(FILES_PER_WORKER, 4)).toBe(1);
  });

  test('a unit past it gets a worker per share, never more than the runner has', () => {
    expect(workersFor(FILES_PER_WORKER + 1, 4)).toBe(2);
    expect(workersFor(FILES_PER_WORKER * 3, 4)).toBe(3);
    expect(workersFor(660, 4)).toBe(4);
    expect(workersFor(660, 1)).toBe(1);
  });

  test('a unit with no test file still runs once, so X_COVERAGE_UNMEASURED can say so', () => {
    expect(workersFor(0, 4)).toBe(1);
  });
});

describe('--jobs', () => {
  test('defaults to every core and refuses anything but a positive integer', () => {
    expect(concurrency(undefined)).toBe(Math.max(1, navigator.hardwareConcurrency));
    expect(concurrency('3')).toBe(3);
    for (const bad of ['0', '-1', '1.5', 'all', '']) expect(concurrency(bad)).toBeUndefined();
  });
});

/** Lets every settled promise's continuations run — the pool refills on a resolution, never a timer. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

/**
 * A `run` that holds every item until the test releases it, so the test — never the wall clock —
 * decides what finishes when, and reads what the pool started at each point.
 */
function gated<T>() {
  const started: T[] = [];
  const gates = new Map<T, () => void>();
  return {
    started,
    run: (item: T): Promise<T> => {
      started.push(item);
      const { promise, resolve } = Promise.withResolvers<void>();
      gates.set(item, resolve);
      return promise.then(() => item);
    },
    release: async (item: T): Promise<void> => {
      gates.get(item)?.();
      await settle();
    },
  };
}

describe('the lease pool', () => {
  test('answers in input order, never in finishing order', async () => {
    const items = ['a', 'b', 'c', 'd'];
    const gate = gated<string>();
    const out = leasePool(items, 4, () => 1, gate.run);
    await settle();
    for (const item of ['d', 'b', 'c', 'a']) await gate.release(item);
    expect(await out).toEqual(items);
  });

  test('never holds more cores than its capacity, summed over what each item leased', async () => {
    const items = [4, 1, 2, 1, 3, 1, 2, 1].map((weight, id) => ({ id, weight }));
    const gate = gated<(typeof items)[number]>();
    const released = new Set<number>();
    const out = leasePool(items, 4, (item) => item.weight, gate.run);
    await settle();
    let peak = 0;
    while (released.size < items.length) {
      const running = gate.started.filter((item) => !released.has(item.id));
      peak = Math.max(
        peak,
        running.reduce((sum, item) => sum + item.weight, 0),
      );
      const next = running[0];
      if (next === undefined) expect.unreachable('the pool stalled with items still queued');
      released.add(next.id);
      await gate.release(next);
    }
    await out;
    expect(peak).toBe(4);
  });

  test('with every weight 1 it is a plain pool of `capacity` in flight', async () => {
    const gate = gated<number>();
    const out = leasePool([1, 2, 3, 4, 5, 6, 7], 3, () => 1, gate.run);
    await settle();
    expect(gate.started).toEqual([1, 2, 3]);
    await gate.release(2);
    // One out, one in — never two.
    expect(gate.started).toEqual([1, 2, 3, 4]);
    for (const item of [1, 3, 4, 5, 6, 7]) await gate.release(item);
    expect(await out).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test('starts the widest first, so the long pole is not the last thing begun', async () => {
    const width: Readonly<Record<string, number>> = { a: 1, b: 1, pole: 4, mid: 2 };
    const gate = gated<string>();
    const out = leasePool(['a', 'b', 'pole', 'mid'], 4, (name) => width[name] ?? 1, gate.run);
    await settle();
    // The pole holds every core: nothing else starts beside it.
    expect(gate.started).toEqual(['pole']);
    await gate.release('pole');
    expect(gate.started).toEqual(['pole', 'mid', 'a', 'b']);
    for (const item of ['mid', 'a', 'b']) await gate.release(item);
    expect(await out).toEqual(['a', 'b', 'pole', 'mid']);
  });

  test('fills the cores a wide item leaves free with narrow ones, rather than idling', async () => {
    const gate = gated<string>();
    const out = leasePool(['wide', 'narrow'], 4, (name) => (name === 'wide' ? 3 : 1), gate.run);
    await settle();
    // The narrow item runs beside the wide one, not after it.
    expect(gate.started).toEqual(['wide', 'narrow']);
    await gate.release('narrow');
    await gate.release('wide');
    expect(await out).toEqual(['wide', 'narrow']);
  });

  test('a weight above capacity is run alone, never deadlocked', async () => {
    const out = await leasePool(
      [9, 1],
      4,
      (weight) => weight,
      async (weight) => weight,
    );
    expect(out).toEqual([9, 1]);
  });

  test('a failed item rejects the pool, and the cores it held are released for no one', async () => {
    const run = leasePool(
      [1, 2],
      2,
      () => 1,
      async (n) => {
        // Input, not a verdict: what the gate's `measure` throws for a suite that fails alone.
        if (n === 2) {
          throw new ScriptError({ code: 'X_TEST_FAILED', cause: 'unit 2 failed', fix: 'rerun' });
        }
        return n;
      },
    );
    await expect(run).rejects.toBeInstanceOf(ScriptError);
  });
});

describe('what one unit is weighed by when shards are dealt', () => {
  test('a measured unit weighs its measured core-seconds', () => {
    expect(unitWeight('cli', { cli: 900, money: 4 })).toBe(900);
    expect(unitWeight('money', { cli: 900, money: 4 })).toBe(4);
  });

  test('a unit nobody measured yet weighs the median, so a new package cannot pile onto one shard', () => {
    expect(unitWeight('brand-new', { a: 10, b: 30, c: 500 })).toBe(30);
    expect(unitWeight('brand-new', {})).toBe(1);
  });

  test('the table is measured, not invented: every number positive, and only units that exist', () => {
    const units = new Set(unitsToGate(repoRoot()));
    for (const [name, seconds] of Object.entries(UNIT_SECONDS)) {
      expect({ name, known: units.has(name) }).toEqual({ name, known: true });
      expect(seconds).toBeGreaterThan(0);
    }
    // `cli` is the long pole the weighing exists for; a table that lost it balances nothing.
    expect(UNIT_SECONDS['cli']).toBeGreaterThan(UNIT_SECONDS['scripts'] ?? 0);
  });
});

describe('the env a unit runs in', () => {
  // Units run side by side, and a widened one runs as bun workers 1..n: two units seeing one
  // TEST_DATABASE_URL would clone `ultimate_test_template_w1` each and drop the other's (`DROP
  // DATABASE … WITH (FORCE)`). The pins are measured with no services anyway (`coverage-pins.ts`).
  test('every test-service URL is taken away, and nothing else', () => {
    const env = {
      PATH: '/bin',
      HOME: '/home/a',
      TEST_DATABASE_URL: 'postgres://x',
      TEST_REDIS_URL: 'redis://x',
      DATABASE_URL: 'postgres://y',
    };
    expect(unitEnv(env, ['TEST_DATABASE_URL', 'TEST_REDIS_URL', 'DATABASE_URL'])).toEqual({
      PATH: '/bin',
      HOME: '/home/a',
    });
  });

  test('the keys are read from docker/test-services.env, so a new service is stripped unasked', () => {
    const keys = serviceKeys(repoRoot());
    for (const key of ['TEST_DATABASE_URL', 'TEST_REDIS_URL', 'TEST_NATS_URL', 'TEST_S3_URL']) {
      expect(keys).toContain(key);
    }
    // `acquireWorkerDatabase` falls back to it, so a laptop's app URL is a service too.
    expect(keys).toContain('DATABASE_URL');
    expect(keys.every((key) => /^[A-Z][A-Z0-9_]*$/.test(key))).toBe(true);
  });
});
