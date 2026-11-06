// Single responsibility: `checkDrift` on a correct partitioned database answers `ok: true` — no
// missing key or index on the parent, no partition reported as a stray with `drop table` as its
// fix — and still finds a key or an index that is genuinely missing. Real embedded catalog.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { checkDrift } from './drift';
import { migrate } from './migrate';
import { CREATE_EVENTS, fixtureIsPartitioned, partitionFor } from './partitioned-fixture';
import { pgliteClient } from './pglite';
import { raw } from './sql';

const PGLITE_BOOT_MS = 60_000;

describe('checkDrift · a partitioned table', () => {
  const client = pgliteClient();
  const migrations = [CREATE_EVENTS];

  beforeEach(async () => {
    await client.execute(raw('drop schema public cascade'));
    await client.execute(raw('create schema public'));
    await migrate({ migrations, appVersion: 'test', client });
  }, PGLITE_BOOT_MS);

  afterAll(async () => {
    await client.close();
  });

  test('the fixture is partitioned, so this suite is not judging a plain table', async () => {
    expect(fixtureIsPartitioned()).toBe(true);
    const row = await client.one<{ kind: string }>(
      raw(`select relkind as kind from pg_class where relname = 'events'`),
    );
    expect(row?.kind).toBe('p');
  });

  test('the probe: a correct partitioned database is `{"ok":true,"differences":[]}`', async () => {
    expect(await checkDrift({ migrations, client })).toEqual({ ok: true, differences: [] });
  });

  test("next month's partition, as the app's task adds it, is still no drift", async () => {
    await client.execute(raw(partitionFor('2026_12', '2026-12-01', '2027-01-01')));
    await client.execute(raw(partitionFor('2026_12', '2026-12-01', '2027-01-01')));
    expect(await checkDrift({ migrations, client })).toEqual({ ok: true, differences: [] });
  });

  test('a detached partition is a stray table again — retention is detach, then drop', async () => {
    await client.execute(raw('alter table "events" detach partition "events_2026_11"'));
    const report = await checkDrift({ migrations, client });
    expect(report.differences.map((d) => `${d.kind} ${d.table}`)).toEqual([
      'unexpected-table events_2026_11',
    ]);
  });

  test('an index truly missing from the parent is still found', async () => {
    await client.execute(raw('drop index "events_kind_idx"'));
    const report = await checkDrift({ migrations, client });
    expect(report.differences.map((d) => `${d.kind} ${d.table}`)).toEqual(['missing-index events']);
  });

  test('a primary key truly missing from the parent is still found', async () => {
    await client.execute(raw('alter table "events" drop constraint "events_pkey"'));
    const report = await checkDrift({ migrations, client });
    expect(report.differences.map((d) => `${d.kind} ${d.table}`)).toEqual([
      'changed-primary-key events',
    ]);
  });
});
