// `purge({ entities: 'declared' })` against a real Postgres — the embedded one, migrated by the
// migration `x db gen` writes for the entities: rows past the window go, newer rows stay, the sweep
// runs in batches, and a history table's own window is swept through its guard (`x.purge`).
// Opt-in (`.job.`): booting Postgres costs seconds.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { clearRegistry, entity, text, timestamp, uuid } from '@ultimat3/entity';
import { resetJobs } from './job';
import { purge } from './purge';
import {
  resetPurgeCoverage,
  retainedEntities,
  retainTarget,
  unsweptEntities,
} from './purge-entities';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-11-06T00:00:00.000Z');

const events = entity('pe_events', {
  columns: {
    id: uuid().primaryKey(),
    body: text(),
    createdAt: timestamp().defaultNow(),
  },
  indexes: [{ on: ['createdAt'] }],
  retain: { after: '30d', on: 'createdAt' },
  history: { retain: { after: '7d' } },
});
const client = pgliteClient();

beforeAll(async () => {
  setDbClient(client);
  const history = events.$history ?? expect.unreachable('history declared');
  const migration = generateMigration({
    entities: [events.$describe(), history.$describe()],
    name: 'retain',
    now: new Date(NOW),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, 30_000);

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  resetJobs();
  resetPurgeCoverage();
});

afterAll(() => {
  clearRegistry();
});

const count = async (table: string): Promise<number> =>
  Number((await client.one<{ n: string }>(raw(`select count(*) as n from "${table}"`)))?.n ?? -1);

describe('retain · the sweep', () => {
  test('old rows go, new rows stay, in batches; the history window is swept too', async () => {
    for (let n = 0; n < 5; n += 1) {
      await client.execute(
        raw(
          `insert into pe_events (id, body, created_at) values (gen_random_uuid(), 'old', now() - interval '40 days')`,
        ),
      );
    }
    await client.execute(raw(`insert into pe_events (id, body) values (gen_random_uuid(), 'new')`));
    // History rows were stamped `now()` by the trigger; age them past the history window by hand.
    await client.execute(
      raw(`alter table pe_events_history disable trigger ultimate_history_guard`),
    );
    await client.execute(raw(`update pe_events_history set at = now() - interval '8 days'`));
    await client.execute(
      raw(`alter table pe_events_history enable trigger ultimate_history_guard`),
    );
    expect(await count('pe_events_history')).toBe(6);

    const at = Date.now();
    const removed = await retainTarget(events, { batchSize: 2 }).purgeExpired(at);
    expect(removed).toBe(5);
    expect(await count('pe_events')).toBe(1);
    // The five deletes were recorded, fresh; the six aged inserts are past 7d.
    const history = events.$history ?? expect.unreachable('history declared');
    expect(await retainTarget(history).purgeExpired(at)).toBe(6);
    expect(await count('pe_events_history')).toBe(5);
    expect(DAY_MS).toBeGreaterThan(0);
  });

  test('declared coverage: unswept until a purge names the entities', () => {
    resetPurgeCoverage();
    expect(retainedEntities().map((entity) => entity.$name)).toEqual([
      'pe_events',
      'pe_events_history',
    ]);
    expect(unsweptEntities()).toEqual(['pe_events', 'pe_events_history']);
    purge({ name: 'pe.purge', entities: 'declared' });
    expect(unsweptEntities()).toEqual([]);
  });
});
