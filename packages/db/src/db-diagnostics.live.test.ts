// Single responsibility: `dbDiagnostics()` against a real Postgres — a blocker held on a second
// connection is named by pid, a `not valid` constraint and an unused index appear, a unique index
// does not. Skips unless `TEST_DATABASE_URL` is set, like `client.live.test.ts`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type PostgresClient, postgresClient } from './client';
import { type DbDiagnostics, dbDiagnostics } from './db-diagnostics';
import { driverError } from './errors';
import { sql } from './sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

/** Re-asked until the waiter is queued: the lock wait starts when the server reads the statement. */
async function untilBlocked(client: PostgresClient, waiter: number): Promise<DbDiagnostics> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const report = await dbDiagnostics({ client, limit: 50 });
    if (report.blockers.available && report.blockers.rows.some((row) => row.pid === waiter)) {
      return report;
    }
  }
  return expect.unreachable(`pid ${waiter} never appeared waiting in blockers`);
}

describe.skipIf(!hasPostgres)('live · postgres · dbDiagnostics', () => {
  const clients: PostgresClient[] = [];
  const fresh = (): PostgresClient => {
    const client = postgresClient({ url: url ?? '', role: 'web' });
    clients.push(client);
    return client;
  };
  let one: PostgresClient | undefined;
  /** One pool for setup, every report and teardown: the test server is shared by every suite. */
  const shared = (): PostgresClient => {
    one ??= fresh();
    return one;
  };

  beforeAll(async () => {
    const setup = shared();
    await setup.execute(sql`drop table if exists x_live_diag_child`);
    await setup.execute(sql`drop table if exists x_live_diag`);
    await setup.execute(sql`create table x_live_diag (id int primary key, title text, n int)`);
    await setup.execute(sql`create index x_live_diag_title_idx on x_live_diag (title)`);
    await setup.execute(sql`create unique index x_live_diag_n_key on x_live_diag (n)`);
    await setup.execute(sql`insert into x_live_diag values (1, 'secret-row-value', -1)`);
    await setup.execute(
      sql`alter table x_live_diag add constraint x_live_diag_n_check check (n > 0) not valid`,
    );
  });

  afterAll(async () => {
    const teardown = shared();
    await teardown.execute(sql`drop table if exists x_live_diag`);
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  test('a lock held on a second connection names its pid as blocked_by', async () => {
    const holder = fresh();
    const waiting = fresh();
    using held = await holder.reserve();
    await held.execute(sql`BEGIN`);
    await held.execute(sql`lock table x_live_diag in access exclusive mode`);
    const holderPid = (await held.one<{ pid: number }>(sql`select pg_backend_pid() as pid`))?.pid;

    using waiter = await waiting.reserve();
    const waiterPid = (await waiter.one<{ pid: number }>(sql`select pg_backend_pid() as pid`))?.pid;
    const queued = waiter.query(sql`select count(*) from x_live_diag`);

    const report = await untilBlocked(shared(), waiterPid ?? -1);
    if (!report.blockers.available) return expect.unreachable('blockers answered');
    const row = report.blockers.rows.find((candidate) => candidate.pid === waiterPid);
    expect(row?.blockedBy).toBe(holderPid ?? -1);
    expect(row?.query).toBe('select count(*) from x_live_diag');
    // `X_DB_LOCK_TIMEOUT`'s fix pipes this section through jq: every field it names is on a real row.
    const fix = driverError('alter table x', { errno: '55P03', severity: 'ERROR' }).fix;
    const fields = /\.rows\[\] \| \{([^}]*)\}/
      .exec(fix)?.[1]
      ?.split(',')
      .map((f) => f.trim());
    expect(fields).toEqual(['pid', 'blockedBy', 'blockerState']);
    for (const field of fields ?? []) expect(Object.keys(row ?? {})).toContain(field);
    expect(row?.blockerState).toBe('idle in transaction');

    await held.execute(sql`ROLLBACK`);
    await queued;
  });

  test('not valid, unused and invalid are facts; a unique index is never "unused"', async () => {
    const report = await dbDiagnostics({ client: shared(), limit: 500 });
    if (!report.notValidConstraints.available) return expect.unreachable('constraints answered');
    expect(report.notValidConstraints.rows).toContainEqual({
      schema: 'public',
      table: 'x_live_diag',
      constraint: 'x_live_diag_n_check',
      kind: 'check',
    });
    if (!report.unusedIndexes.available) return expect.unreachable('unusedIndexes answered');
    const unused = report.unusedIndexes.rows.map((row) => row.index);
    expect(unused).toContain('x_live_diag_title_idx');
    expect(unused).not.toContain('x_live_diag_n_key');
    expect(unused).not.toContain('x_live_diag_pkey');
    // No section reads a user table: the row inserted above is nowhere in the answer.
    expect(JSON.stringify(report)).not.toContain('secret-row-value');
    const parsed = new URL(url ?? 'postgres://localhost');
    expect(JSON.stringify(report)).not.toContain(`${parsed.username}:${parsed.password}@`);
    expect(JSON.stringify(report)).not.toContain(parsed.host);
  });
});
