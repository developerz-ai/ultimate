// The crash proof's runs are paced on the pass's frozen clock: a `backfill()` throttle is a move of
// the instant, never a wall-clock sleep. Built on `ctxOf`'s live clock, every killed rerun of a
// three-page backfill slept its `rate` interval for real — 4 s of the reference app's 23 s pass.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { backfill } from '@ultimat3/jobs';
import { frozenNow } from './determinism';
import { proveCrash } from './exercise-crash';
import { testName } from './test-types';

afterAll(() => {
  clearRegistry();
});

const rows = entity('ecr_rows', {
  columns: { id: uuid().primaryKey(), title: text({ max: 40 }) },
});
const driver = memoryDriver();
const db = database({ rows }, { driver });
const repo = driver.repo(rows);

/** One batch a second: each batch after the first waits 1,000 ms on the clock it is handed. */
const RATE = 1;
const ROWS = 3;
/** The frozen instant each batch's handle ran at, every run of the proof in order. */
const seen: number[] = [];

const sweep = backfill({
  tenant: 'none',
  name: 'ecr-sweep',
  batch: 1,
  rate: RATE,
  source: () => db.rows,
  handle: async ({ rows: page }) => {
    seen.push(frozenNow().getTime());
    for (const row of page) await db.rows.update(row.id, { title: row.title.trim() });
  },
});

describe(testName('unit', 'proveCrash · the throttle is paced on the frozen clock'), () => {
  test('a paced backfill moves the frozen instant and holds', async () => {
    for (let i = 0; i < ROWS; i += 1) {
      await repo.insert({ id: crypto.randomUUID(), title: ` row ${String(i)} ` } as never);
    }
    const proof = await proveCrash(sweep, {}, null);
    expect(proof.verdict).toBe('held');
    // A batch after its predecessor is one interval later on the frozen clock. A wall-clock sleep
    // leaves every batch of a run at one instant (and spends the interval for real).
    const steps = seen.slice(1).map((at, i) => at - (seen[i] as number));
    expect(steps).toContain(1000 / RATE);
  });
});
