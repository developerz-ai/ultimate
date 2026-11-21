// Single responsibility: Postgres through a real transaction pooler in its stock config, the table
// `docs/ops/04-datastores.md` states, inverted. A bare URL names the switch; the switch serves every
// path the framework uses; the bound comes back through `alter role`, and a migrator is refused.
// Skips unless `TEST_POOLER_URL` is set. The pooler dials the `TEST_DATABASE_URL` server. A case
// that runs a printed `fix:` needs no Postgres client on the host: without one, a stub `psql`
// prints the statements the line hands it and this file runs them over the same connection.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { type PostgresClient, postgresClient } from './client';
import type { DbError } from './errors';
import { lostStatementBound, statementBound } from './pooler';
import { readOnlyQuery } from './readonly-query';
import { raw, sql } from './sql';
import { withTransaction } from './transaction';

const poolerUrl = Bun.env['TEST_POOLER_URL'];
const directUrl = Bun.env['TEST_DATABASE_URL'];
const hasPooler =
  typeof poolerUrl === 'string' &&
  poolerUrl.length > 0 &&
  typeof directUrl === 'string' &&
  directUrl.length > 0;

/** Whether the printed `fix:` lines below can be run by a real `psql`, as written. */
const realPsql = Bun.which('psql') !== null;

/**
 * A `psql` the shell can call where the host has none: it prints every `-c` argument, so the line is
 * still read by the shell that would run it — its `sed` on the URL, its quoting, its `&&` — and only
 * the client is missing. `object-drift.live.test.ts:115-118` reads a fix: through the same stub;
 * `drift-check.live.test.ts:157-175` runs it for real when the tool is there.
 */
const STUB_PSQL =
  'psql() { while [ $# -gt 0 ]; do if [ "$1" = "-c" ]; then printf \'%s\\n\' "$2"; shift 2; ' +
  'else shift; fi; done; }';

/** `line` behind the stub when no real client exists; the host's own shell either way. */
const withPsql = (line: string): string => (realPsql ? line : `${STUB_PSQL}\n${line}`);

/** The statements the stub collected: every line but the trailing marker the case prints. */
const stubStatements = (stdout: string): readonly string[] =>
  stdout
    .split('\n')
    .slice(0, -1)
    .filter((statement) => statement !== '');

/** A login of its own: `alter role` on the suite's shared one would reach every other suite. */
const BOUND_ROLE = `x_pooler_live_${String(process.pid)}`;
const IDLE_ROLE = `x_pooler_idle_${String(process.pid)}`;
const OWN_ROLE = `x_pooler_own_${String(process.pid)}`;

describe.skipIf(!hasPooler)('live · a transaction pooler in its stock config', () => {
  const clients: PostgresClient[] = [];

  const through = (options: Partial<Parameters<typeof postgresClient>[0]> = {}): PostgresClient => {
    const client = postgresClient({
      url: poolerUrl ?? '',
      role: 'web',
      env: { DATABASE_POOLER: 'transaction' },
      profile: { max: 2 },
      ...options,
    });
    clients.push(client);
    return client;
  };

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  afterAll(async () => {
    const admin = postgresClient({ url: directUrl ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop role if exists ${BOUND_ROLE}`));
    await admin.execute(raw(`drop role if exists ${IDLE_ROLE}`));
    await admin.execute(raw(`drop role if exists ${OWN_ROLE}`));
    await admin.close();
  });

  test('a bare URL names the switch, not an outage', async () => {
    const refused = await postgresClient({ url: poolerUrl ?? '', role: 'web', env: {} })
      .query(sql`select 1`)
      .catch((error: unknown) => error as DbError);

    expect((refused as DbError).code).toBe('X_DB_POOLER_OPTIONS_REFUSED');
    expect((refused as DbError).fix).toContain('DATABASE_POOLER=transaction');
  });

  test('DATABASE_POOLER=transaction runs a statement', async () => {
    expect(await through().one<{ readonly up: number }>(sql`select 1 as up`)).toEqual({ up: 1 });
  });

  test('a withTransaction commits, and a throw inside it rolls back', async () => {
    const client = through();
    const table = `x_pooler_live_tx_${String(process.pid)}`;
    await client.execute(raw(`create table ${table} (id int primary key)`));
    try {
      await withTransaction(
        async (tx) => {
          await tx.execute(raw(`insert into ${table} values (1)`));
        },
        { client },
      );
      const thrown = await withTransaction(
        async (tx) => {
          await tx.execute(raw(`insert into ${table} values (2)`));
          await tx.execute(raw(`insert into ${table} values (1)`));
        },
        { client },
      ).catch((error: unknown) => error as DbError);

      expect((thrown as DbError).code).toBe('X_DB_UNIQUE_VIOLATION');
      expect(await client.query(raw(`select id from ${table} order by id`))).toEqual([{ id: 1 }]);
    } finally {
      await client.execute(raw(`drop table ${table}`));
    }
  });

  test('a readOnlyQuery answers, and its guards stay inside its own transaction', async () => {
    const client = through();
    const report = await readOnlyQuery('select 1 as up', { client });

    expect(report.rows).toEqual([{ up: 1 }]);
    const after = await client.one<{ readonly value: string }>(
      sql`select current_setting('transaction_read_only') as value`,
    );
    expect(after?.value).toBe('off');
  });

  test('statementBound reports 0, and the verdict says the bound is gone', async () => {
    const client = through();
    const bound = await statementBound(client);

    expect(bound.statementTimeout).toEqual({ applied: 0, expected: 10_000 });
    expect(bound.idleInTransaction).toEqual({ applied: 0, expected: 30_000 });
    expect(lostStatementBound(bound, 'web', client.pooler)?.code).toBe('X_DB_STATEMENT_BOUND_LOST');
  });

  test('the fix the refusal prints, run as printed, brings the bound back', async () => {
    const admin = postgresClient({ url: directUrl ?? '', role: 'web', profile: { max: 1 } });
    clients.push(admin);
    await admin.execute(raw(`create role ${BOUND_ROLE} login password 'bound'`));
    const refused = await postgresClient({ url: poolerUrl ?? '', role: 'web', env: {} })
      .query(sql`select 1`)
      .catch((error: unknown) => error as DbError);
    // The emitted line, its one placeholder filled, then the variable the export left behind.
    const fix = (refused as DbError).fix.replaceAll('<user>', BOUND_ROLE);
    const shell = Bun.spawnSync(
      ['bash', '-c', withPsql(`${fix}\nprintf '%s' "$DATABASE_POOLER"`)],
      {
        env: { PATH: process.env['PATH'] ?? '', DATABASE_URL: poolerUrl ?? '' },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      },
    );
    expect(shell.stderr.toString()).toBe('');
    expect(shell.exitCode).toBe(0);
    const printed = shell.stdout.toString();
    const exported = printed.split('\n').at(-1);
    expect(exported).toBe('transaction');
    // No host client: the statements the line handed the stub run here, so the bound is still
    // proved. With a real `psql` it already ran them, and what it prints is a command tag.
    if (!realPsql) {
      for (const statement of stubStatements(printed)) await admin.execute(raw(statement));
    }

    const login = new URL(poolerUrl ?? '');
    login.username = BOUND_ROLE;
    login.password = 'bound';
    const client = through({ url: login.toString(), env: { DATABASE_POOLER: exported ?? '' } });
    const bound = await statementBound(client);

    expect(bound.statementTimeout.applied).toBe(10_000);
    expect(bound.idleInTransaction.applied).toBe(30_000);
    expect(lostStatementBound(bound, 'web', client.pooler)).toBeUndefined();
  });

  test('an option of the operator own refused: the printed fix connects without it, and runs', async () => {
    const admin = postgresClient({ url: directUrl ?? '', role: 'web', profile: { max: 1 } });
    clients.push(admin);
    await admin.execute(raw(`drop role if exists ${OWN_ROLE}`));
    await admin.execute(raw(`create role ${OWN_ROLE} login password 'own'`));
    const carrying = new URL(poolerUrl ?? '');
    carrying.username = OWN_ROLE;
    carrying.password = 'own';
    carrying.searchParams.set('options', '-c lock_timeout=1000');
    const refused = await through({ url: carrying.toString() })
      .query(sql`select 1`)
      .catch((error: unknown) => error as DbError);
    expect((refused as DbError).code).toBe('X_DB_POOLER_OPTIONS_REFUSED');

    const fix = (refused as DbError).fix.replaceAll('<user>', OWN_ROLE).replaceAll('<value>', '1s');
    const shell = Bun.spawnSync(['bash', '-c', withPsql(fix)], {
      env: { PATH: process.env['PATH'] ?? '', DATABASE_URL: carrying.toString() },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    });
    expect(shell.stderr.toString()).toBe('');
    expect(shell.exitCode).toBe(0);
    // The one statement the fix prints, run against the server when the stub stood in for psql;
    // a real `psql` ran it, and what it leaves on stdout is a command tag.
    if (!realPsql) {
      for (const statement of stubStatements(`${shell.stdout.toString()}\n`)) {
        await admin.execute(raw(statement));
      }
    }
    const row = await admin.one<{ readonly settings: readonly string[] | null }>(
      sql`select setconfig as settings from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname = ${OWN_ROLE}`,
    );
    expect(row?.settings).toEqual(['lock_timeout=1s']);
  });

  test('an idle transaction ends through it too, once the role says so', async () => {
    const admin = postgresClient({ url: directUrl ?? '', role: 'web', profile: { max: 1 } });
    clients.push(admin);
    await admin.execute(raw(`drop role if exists ${IDLE_ROLE}`));
    await admin.execute(raw(`create role ${IDLE_ROLE} login password 'idle'`));
    await admin.execute(
      raw(`alter role ${IDLE_ROLE} set idle_in_transaction_session_timeout = '200ms'`),
    );
    const login = new URL(poolerUrl ?? '');
    login.username = IDLE_ROLE;
    login.password = 'idle';
    const client = through({ url: login.toString(), profile: { max: 1 } });

    const refused = await withTransaction(
      async (tx) => {
        const row = await tx.one<{ readonly pid: number }>(sql`select pg_backend_pid() as pid`);
        for (let pass = 0; pass < 500; pass += 1) {
          const seen = await admin.one<{ readonly alive: boolean }>(
            sql`select exists (select 1 from pg_stat_activity where pid = ${row?.pid ?? 0}) as alive, pg_sleep(0.01)`,
          );
          if (seen?.alive === false) break;
        }
        return tx.query(sql`select 1`);
      },
      { client },
    ).catch((error: unknown) => error as DbError);

    expect((refused as DbError).code).toBe('X_DB_STATEMENT_FAILED');
    expect((refused as DbError).meta?.['sqlState']).toBe('25P03');
    expect(await client.one<{ readonly up: number }>(sql`select 1 as up`)).toEqual({ up: 1 });
  });

  test('ROLE=migrate through it refuses, naming the server port', () => {
    expect(() => through({ role: 'migrate' })).toThrow('X_DB_POOLER_SESSION_REQUIRED');
  });
});
