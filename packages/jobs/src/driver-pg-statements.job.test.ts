// Statement PREDICATES on a real Postgres, where `driver-pg-stores.test.ts`'s recorded parameters
// cannot reach: what a `where` clause matches. Opt-in (`.job.`): booting Postgres costs seconds.
// The embedded database's `now()` is frozen with the test clock, so one wake slot lasts until rows
// are aged out of it — which makes "one per slot" exact.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { postgresJobDriver } from './driver-pg';
import { JOBS_WAKE_CHANNEL } from './driver-pg-wake-sql';
import type { EmbeddedPg } from './embedded-pg-fixture';
import { embeddedPg } from './embedded-pg-fixture';
import { operatorOf } from './operator-surface-fixture';

let pg: EmbeddedPg;
let heard: string[] = [];
let tap: { unlisten(): Promise<void> } | undefined;

beforeEach(async () => {
  pg = await embeddedPg();
  await pg.reset();
  heard = [];
  tap = await pg.listener.listen(JOBS_WAKE_CHANNEL, (payload) => {
    heard.push(payload);
  });
});

afterEach(async () => {
  await tap?.unlisten();
});

/**
 * The boot is this suite's setup, not any one test's work: booted inside the first test's hook it
 * ran on that test's 5 s budget, and under `--rerun-each` or a loaded `job` step it overran — the
 * boot went on in the background (bun cancels nothing) and starved whatever test ran next. Its own
 * budget, as `queue-wake.job.test.ts` measures it (32-42 s loaded); every test keeps the default.
 */
const PGLITE_BOOT_MS = 120_000;

beforeAll(async () => {
  await embeddedPg();
}, PGLITE_BOOT_MS);

afterAll(async () => {
  await (await embeddedPg()).close();
});

const enqueue = (driver: JobDriver, key: string, extra: { queue?: string; runAt?: number } = {}) =>
  driver.enqueue({
    name: 'statements.probe',
    queue: extra.queue ?? 'default',
    input: {},
    idempotencyKey: key,
    maxAttempts: 1,
    ...(extra.runAt === undefined ? {} : { runAt: extra.runAt }),
  });

/**
 * Notifications are delivered in this process, behind the statement that sent them: a few turns of
 * the event loop are their turn. The database is in-process, so no wall-clock wait is theirs.
 */
const delivered = async (): Promise<readonly string[]> => {
  for (let turn = 0; turn < 6; turn += 1) await new Promise((done) => setImmediate(done));
  return heard;
};

describe('list({ idPrefix })', () => {
  test('a prefix is literal on both drivers: `_` and `%` are characters, not wildcards', async () => {
    const drivers = [postgresJobDriver({ executor: pg.executor }), memoryJobDriver()];
    for (const driver of drivers) {
      const { id } = await enqueue(driver, `prefix:${driver.name}`);
      const list = async (idPrefix: string) =>
        (await operatorOf(driver).list({ idPrefix })).map((row) => row.id);
      expect({ driver: driver.name, rows: await list(id.slice(0, 4)) }).toEqual({
        driver: driver.name,
        rows: [id],
      });
      // `like` read these as "any one character" and "anything": a page memory never answers.
      for (const pattern of [`${id.slice(0, 3)}_`, '%']) {
        expect({ driver: driver.name, pattern, rows: await list(pattern) }).toEqual({
          driver: driver.name,
          pattern,
          rows: [],
        });
      }
    }
  });
});

describe('the enqueue wake', () => {
  test('a row that sent no wake does not silence the next one in its slot', async () => {
    const driver = postgresJobDriver({ executor: pg.executor });
    // Created first in the slot and due in an hour: it is not due soon, so it notifies nobody.
    await enqueue(driver, 'far', { queue: 'mail', runAt: Date.now() + 3_600_000 });
    expect(await delivered()).toEqual([]);
    // A row due now must still wake the queue, or it waits out a whole idle backoff.
    await enqueue(driver, 'now', { queue: 'mail' });
    expect(await delivered()).toEqual(['mail']);
    // And that one wake is the slot's: the next due row stays silent.
    await enqueue(driver, 'again', { queue: 'mail' });
    expect(await delivered()).toEqual(['mail']);
  });
});
