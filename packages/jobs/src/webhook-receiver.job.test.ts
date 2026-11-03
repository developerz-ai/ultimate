// `webhookReceiver()` on the pg driver and a real Postgres: a redelivery while the job is LIVE is
// one row and one `handle`; a redelivery after it SETTLED is a second run with the same `eventId`.
// Pinned so nobody documents exactly-once — the seen-set past the queue's window is the app's.
// Opt-in (`.job.`): booting Postgres costs seconds.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { JobDriver } from './driver';
import { resetJobDriver, setJobDriver } from './driver';
import { postgresJobDriver } from './driver-pg';
import { embeddedPg } from './embedded-pg-fixture';
import { resetJobs } from './job';
import { resetJobsFacade } from './outbox';
import { resetTasks } from './task';
import { receiverHarness } from './webhook-receiver-fixture';

const PATH = '/hooks/vendor/acct_1';
const BODY = '{"id":"evt_42","type":"invoice.paid"}';

let driver: JobDriver;

beforeEach(async () => {
  resetJobs();
  resetTasks();
  resetJobsFacade();
  const pg = await embeddedPg();
  await pg.reset();
  driver = postgresJobDriver({ executor: pg.executor });
  setJobDriver(driver);
});

afterEach(() => {
  resetJobs();
  resetTasks();
  resetJobDriver();
});

afterAll(async () => {
  await (await embeddedPg()).close();
});

describe('webhookReceiver on Postgres · what a redelivery does', () => {
  test('a redelivery while the job is live is deduped, and handle runs once', async () => {
    const h = receiverHarness();
    const first = await h.post(PATH, BODY, { eventId: 'evt_42' });
    const again = await h.post(PATH, BODY, { eventId: 'evt_42' });
    expect(await first.json()).toEqual({ ok: true, eventId: 'evt_42', deduped: false });
    expect(await again.json()).toEqual({ ok: true, eventId: 'evt_42', deduped: true });

    const worker = h.worker(driver);
    await worker.tick();
    await worker.tick();
    expect(h.seen.handled.map((run) => run.eventId)).toEqual(['evt_42']);
  });

  test('a redelivery after the job settled runs handle again, with the same eventId', async () => {
    const h = receiverHarness();
    const worker = h.worker(driver);
    await h.post(PATH, BODY, { eventId: 'evt_42' });
    expect((await worker.tick()).map((run) => run.outcome)).toEqual(['completed']);

    const late = await h.post(PATH, BODY, { eventId: 'evt_42' });
    expect(await late.json()).toEqual({ ok: true, eventId: 'evt_42', deduped: false });
    await worker.tick();
    // At least once past the live window: the app's own seen-set is what dedupes this.
    expect(h.seen.handled.map((run) => [run.eventId, run.payload])).toEqual([
      ['evt_42', { text: BODY }],
      ['evt_42', { text: BODY }],
    ]);
  });
});
