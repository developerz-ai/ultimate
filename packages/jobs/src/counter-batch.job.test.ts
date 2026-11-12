// `SQL_COUNTER_FLUSH` against a real Postgres: one statement writes every batched row, and a
// second flush into the same bucket ADDS to it. Opt-in (`.job.`): booting Postgres costs seconds.

import { afterAll, describe, expect, test } from 'bun:test';
import { counterBatch } from './counter-batch';
import { SQL_COUNTER_FLUSH } from './driver-pg-settle-sql';
import { embeddedPg } from './embedded-pg-fixture';
import { COUNTER_BUCKET_MS } from './introspection';

const T0 = Date.UTC(2026, 10, 12, 9, 0, 0);

afterAll(async () => {
  await (await embeddedPg()).close();
});

describe('SQL_COUNTER_FLUSH', () => {
  test('50 acks, one flush: one statement, one row; a second flush adds to it', async () => {
    const pg = await embeddedPg();
    await pg.reset();
    let statements = 0;
    const batch = counterBatch({
      write: async (rows) => {
        statements += 1;
        await pg.executor.query(SQL_COUNTER_FLUSH, [COUNTER_BUCKET_MS, JSON.stringify(rows)]);
      },
      schedule: () => () => undefined,
    });
    for (let i = 0; i < 50; i += 1) batch.add('mail', 'done', 2, T0 + i);
    batch.add('mail', 'dead', 3, T0 + 60_000);
    batch.add('sms', 'retried', 1, T0);
    await batch.flush();
    batch.add('mail', 'failed', 4, T0 + 1);
    await batch.stop();
    expect(statements).toBe(2);

    const rows = await pg.executor.query<Record<string, unknown>>(
      `select job, bucket_ms, (extract(epoch from bucket_start) * 1000)::bigint as start_ms,
              done, retried, failed, dead, duration_ms
         from x_job_counters where bucket_ms = $1 order by job collate "C", bucket_start`,
      [COUNTER_BUCKET_MS],
    );
    const line = ({ job, ...counts }: Record<string, unknown>): string =>
      `${String(job)} ${Object.values(counts).map(Number).join(' ')}`;
    expect(rows.map(line)).toEqual([
      `mail ${COUNTER_BUCKET_MS} ${T0} 50 0 1 0 104`,
      `mail ${COUNTER_BUCKET_MS} ${T0 + 60_000} 0 0 0 1 3`,
      `sms ${COUNTER_BUCKET_MS} ${T0} 0 1 0 0 1`,
    ]);
  });
});
