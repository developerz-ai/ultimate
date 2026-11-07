// The wait's cursor on a real Postgres: a refused event and a valid one stamped within one
// millisecond — and across the half-millisecond the old rounding projection moved — the valid
// one is the answer. Opt-in (`.job.`).

import { afterAll, beforeEach, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { embeddedPg } from './embedded-pg-fixture';
import { postgresEventBus } from './events-pg';
import { refusedThenValidSameMs } from './steps-wait-cursor-fixture';

beforeEach(async () => {
  await (await embeddedPg()).reset();
});

afterAll(async () => {
  await (await embeddedPg()).close();
});

/**
 * Two rows in ONE statement, `bad` and `good` fractional ms into one whole millisecond 5 ms past
 * the database's now — exact stamps, so the case is the same on every run.
 */
async function insertAt(
  bad: number,
  good: number,
  executor: Awaited<ReturnType<typeof embeddedPg>>['executor'],
): Promise<void> {
  const at = (n: number) =>
    `date_trunc('milliseconds', statement_timestamp()) + ((5 + $${n}::numeric) * interval '1 millisecond')`;
  await executor.query(
    `insert into x_job_events (id, name, payload, published_at, expires_at)
     values ($1, 'invoice.approved', $2::jsonb, ${at(5)}, statement_timestamp() + interval '1 hour'),
            ($3, 'invoice.approved', $4::jsonb, ${at(6)}, statement_timestamp() + interval '1 hour')`,
    [
      crypto.randomUUID(),
      JSON.stringify({ amount: 'twelve' }),
      crypto.randomUUID(),
      JSON.stringify({ amount: 12 }),
      bad,
      good,
    ],
  );
}

for (const [label, bad, good] of [
  ['one millisecond', 0.1, 0.2],
  ['the rounding boundary', 0.6, 0.9],
] as const) {
  test(`a valid event within ${label} of the refused one is the answer (pg)`, async () => {
    const pg = await embeddedPg();
    const bus = postgresEventBus({ executor: pg.executor });
    const clock: Clock = { now: () => new Date() } as Clock;
    const answer = await refusedThenValidSameMs(bus, clock, () => insertAt(bad, good, pg.executor));
    expect(answer).toEqual({ amount: 12 });
  });
}
