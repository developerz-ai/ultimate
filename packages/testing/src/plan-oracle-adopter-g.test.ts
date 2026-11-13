// Adopter G's three §26 shapes (field report, 2026-11-07, measured on 30.2.0), as its own tree sends
// them, through the whole sweep on PGlite: oracle, advice and printed fix. Each pins the misfire it
// reported — `on: []`, a key-led `['id', 'x']`, `one()` under a partial unique graded a PK walk.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PgliteClient } from '@ultimat3/db';
import { pgliteClient, raw, recordingClient } from '@ultimat3/db';
import {
  clearRegistry,
  entity,
  postgresRepo,
  tableFor,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import type { ExerciseRecord } from './exercise-report';
import { judgePlan } from './plan-oracle';
import type { PlanProof } from './plan-sweep';
import { sweepPlans } from './plan-sweep';
import { planFindings } from './plan-sweep-fix';
import { planSweepFindings } from './plan-sweep-report';
import { testName } from './test-types';

/** The adopter's `runs`, cut to the columns the three shapes read, with its own indexes. */
const pogRuns = entity('pog_runs', {
  columns: {
    id: uuid().primaryKey(),
    bank: text({ max: 40 }),
    status: text({ max: 20 }),
    testAccountId: uuid().nullable(),
    queuedAt: timestamp(),
    settledAt: timestamp().nullable(),
  },
  indexes: [
    { on: ['bank', 'queuedAt'], order: 'desc' },
    { on: ['testAccountId'], unique: true, where: (c) => c.settledAt.isNull() },
    { on: ['settledAt'] },
  ],
});
/** Its `run_events`: purged by age, a page at a time in key order. */
const pogEvents = entity('pog_events', {
  columns: { id: uuid().primaryKey(), kind: text({ max: 40 }), at: timestamp() },
});
/** The same, with the index the adopter built for it, `(kind, at, id)`, cut to `(kind, at)`. */
const pogEventsIndexed = entity('pog_events_indexed', {
  columns: { id: uuid().primaryKey(), kind: text({ max: 40 }), at: timestamp() },
  indexes: [{ on: ['kind', 'at'] }],
});
const ENTITIES = [pogRuns, pogEvents, pogEventsIndexed];

const DDL = [
  'create table pog_runs (id uuid primary key, bank text not null, status text not null, test_account_id uuid, queued_at timestamptz not null, settled_at timestamptz)',
  'create index pog_runs_bank_queued_at_idx on pog_runs (bank, queued_at desc)',
  'create unique index pog_runs_test_account_id_key on pog_runs (test_account_id) where (settled_at is null)',
  'create index pog_runs_settled_at_idx on pog_runs (settled_at)',
  'create table pog_events (id uuid primary key, kind text not null, at timestamptz not null)',
  'create table pog_events_indexed (id uuid primary key, kind text not null, at timestamptz not null)',
  'create index pog_events_indexed_kind_at_idx on pog_events_indexed (kind, at)',
];

const asRecord = (plans: PlanProof | undefined): ExerciseRecord => ({
  kind: 'query',
  name: 'runScopes',
  outcome: 'reached',
  statements: 1,
  effects: [],
  ms: 1,
  ...(plans === undefined ? {} : { plans }),
});

let client: PgliteClient;
const sweep = async (statement: string): Promise<PlanProof | undefined> =>
  (
    await sweepPlans(client, new Map([[statement, { primitives: new Set(['runScopes']) }]]), [
      ...ENTITIES,
    ])
  ).get('runScopes');
const shapes = (proof: PlanProof | undefined) =>
  proof?.findings.map((one) => [one.code, one.node, one.index, one.unserved]);

beforeAll(async () => {
  client = pgliteClient();
  for (const statement of DDL) await client.execute(raw(statement));
});
afterAll(async () => {
  await client.close();
  clearRegistry();
});

/** A cold PGlite boot, then a handful of plans. */
const PGLITE_MS = 60_000;

describe(testName('unit', 'plan oracle · adopter G §26 shapes, on PGlite'), () => {
  test(
    '(1) a whole-table count per status: a stated scan, never an index on no column',
    async () => {
      const whole = await sweep(
        'select r.status, count(*)::int as runs from pog_runs r where true group by 1',
      );
      expect(shapes(whole)).toEqual([['X_QUERY_UNINDEXED', 'Seq Scan', [], undefined]]);
      const [advice] = planSweepFindings([asRecord(whole)]);
      expect(advice?.fix).toContain("expectedSeqScan('");
      expect(advice?.fix).not.toContain('on: [');
      expect(advice?.fix).not.toContain('x db gen');
      // Filtered by a declared index's leading column, the same count is bounded: no finding.
      const byBank = await sweep(
        'select r.status, count(*)::int as runs from pog_runs r where true and r.bank = $1 group by 1',
      );
      expect(byBank).toMatchObject({ planned: 1, findings: [], unplannable: [] });
    },
    PGLITE_MS,
  );

  test(
    '(2) a range under the primary key order: the range column, never an index led by the key',
    async () => {
      const page = (table: string) =>
        `select id from ${table} where kind = $1 and at < $2 order by id limit 500`;
      const red = await sweep(page('pog_events'));
      expect(shapes(red)).toEqual([['X_QUERY_UNINDEXED', 'Index Scan', ['kind', 'at'], undefined]]);
      const [advice] = planSweepFindings([asRecord(red)]);
      expect(advice?.fix).toContain("indexes: [{ on: ['kind', 'at'] }]");
      const bare = await sweep('select id from pog_events where at < $1 order by id limit 500');
      expect(shapes(bare)).toEqual([['X_QUERY_UNINDEXED', 'Index Scan', ['at'], undefined]]);
      // Its index declared and migrated, the generic plan still walks the key: credited.
      expect(await sweep(page('pog_events_indexed'))).toMatchObject({ findings: [] });
      const settled = 'select id from pog_runs where settled_at < $1 order by id limit 500';
      expect(await sweep(settled)).toMatchObject({ findings: [] });
    },
    PGLITE_MS,
  );

  test(
    '(3) `one()` by a partial unique key, its predicate stated: one row, never a PK walk',
    async () => {
      const recorder = recordingClient();
      const runs = tableFor(pogRuns, postgresRepo(pogRuns, { client: recorder }));
      await runs
        .where({ testAccountId: crypto.randomUUID(), settledAt: null })
        .andWhere('status', 'in', ['queued', 'running'])
        .one();
      const [one] = recorder.texts;
      if (one === undefined) expect.unreachable('one() sent no statement');
      expect(one).toContain('order by "id"');
      expect(one).toContain('limit $');
      expect(await sweep(one)).toMatchObject({ planned: 1, findings: [], unplannable: [] });
    },
    PGLITE_MS,
  );

  test('(3) the plan 30.2.0 judged, sorts off: a PK walk the partial unique key argues away', () => {
    const one =
      'select "id" from "pog_runs" where "test_account_id" = $1 and "settled_at" is null and "status" in ($2, $3) order by "id" asc nulls last limit $4';
    // PGlite's answer under `enable_sort = off`, trimmed to the keys the oracle reads.
    const walk = [
      {
        Plan: {
          'Node Type': 'Limit',
          Plans: [
            {
              'Node Type': 'Index Scan',
              'Relation Name': 'pog_runs',
              Alias: 'pog_runs',
              'Index Name': 'pog_runs_pkey',
              Filter:
                '((settled_at IS NULL) AND (status = ANY (ARRAY[$2, $3])) AND (test_account_id = $1))',
            },
          ],
        },
      },
    ];
    const columns = new Set(pogRuns.$describe().columns.map((c) => c.column));
    const verdicts = judgePlan(walk, new Map([['pog_runs', columns]]));
    expect(verdicts.map((v) => [v.code, v.node])).toEqual([['X_QUERY_UNINDEXED', 'Index Scan']]);
    expect(planFindings(one, verdicts, new Map([['pog_runs', pogRuns]]))).toEqual([]);
  });
});
