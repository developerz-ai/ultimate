// Error groups against Postgres 17 with real concurrency: five sessions inserting the SAME new
// group at once read "new" exactly once — what makes five replicas enqueue `onNewGroup` once —
// and the shared contract holds over a pooled client. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { errorReport, probeDatabaseName, sweepProbeDatabases, UltimateError } from '@ultimat3/core';
import { dbExecutor, type PostgresClient, postgresClient, raw } from '@ultimat3/db';
import { occurrence, STORE_CASES } from './error-groups-fixture';
import { postgresErrorGroupsStore } from './error-groups-pg';
import { SQL_ERROR_GROUPS_TABLE } from './error-groups-schema';
import { type ErrorGroupNotice, errorGroupsSink } from './error-groups-sink';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_admin_error_groups_live');
const REPLICAS = 5;

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

describe.skipIf(!hasPostgres)('live · postgres · x_error_groups', () => {
  let admin: PostgresClient;
  const replicas: PostgresClient[] = [];

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    for (let index = 0; index < REPLICAS; index += 1) {
      replicas.push(postgresClient({ url: probeUrl(), role: 'web', profile: { max: 2 } }));
    }
    for (const statement of SQL_ERROR_GROUPS_TABLE.split(';')) {
      if (statement.trim().length > 0) await replicas[0]?.execute(raw(statement));
    }
  });

  afterAll(async () => {
    for (const replica of replicas) await replica.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  test('five replicas racing on one new group: one isNew, one onNewGroup, count five', async () => {
    const enqueued: ErrorGroupNotice[] = [];
    const onNewGroup = {
      name: 'app.openIssue',
      enqueue: async (input: ErrorGroupNotice) => {
        enqueued.push(input);
        return { id: `job-${enqueued.length}`, runId: `run-${enqueued.length}`, deduped: false };
      },
    };
    const stores = replicas.map((client) => postgresErrorGroupsStore({ client }));
    const answers = await Promise.all(
      stores.map((store) => store.record(occurrence({ fingerprint: 'race' }))),
    );
    expect(answers.filter((answer) => answer.isNew)).toHaveLength(1);
    expect((await stores[0]?.get('race'))?.count).toBe(REPLICAS);

    // The same race through five sinks, one per replica: the app's job is enqueued once.
    const sinks = stores.map((store) => errorGroupsSink({ store, onNewGroup }));
    const report = errorReport(
      new UltimateError({
        code: 'X_RACE',
        cause: 'a fault on every replica',
        fix: 'x jobs list --state dead --json',
      }),
      { source: 'job', scope: { operation: 'orders.sync' } },
    );
    for (const sink of sinks) sink.report(report);
    await Promise.all(sinks.map((sink) => sink.settled()));
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.code).toBe('X_RACE');
  });

  STORE_CASES.forEach(({ name, run }, index) => {
    test(name, () => {
      const client = replicas[0];
      if (client === undefined) return expect.unreachable('no replica client was opened');
      return run(postgresErrorGroupsStore({ client }), `live${index}-`);
    });
  });
});
