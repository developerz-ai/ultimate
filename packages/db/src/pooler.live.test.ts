// Single responsibility: Postgres through a real transaction pooler in its stock config, the table
// `docs/ops/04-datastores.md` states, inverted. A bare URL names the switch; the switch serves every
// path the framework uses; the bound comes back through `alter role`, and a migrator is refused.
// Skips unless `TEST_POOLER_URL` is set. The pooler dials the `TEST_DATABASE_URL` server.

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

  /**
   * The one host tool the printed fixes name. A runner without `psql` is a machine this suite
   * still has a claim to make on: its absence changes HOW the fix is run, never WHETHER the bound
   * comes back (`drift-check.live.test.ts:157`, `object-drift.live.test.ts:87`).
   */
  const hasPsql = Bun.which('psql') !== null;

  /**
   * A shell function of the same name, printing the words the line hands it: the `sed` that drops
   * `options`, the `-c` arguments and the `export` beside them are still the SHELL's, which is the
   * layer these fixes can get wrong. `object-drift.live.test.ts:116` reads a fix the same way.
   */
  const STUB_PSQL = [
    'psql() {',
    '  while [ "$#" -gt 0 ]; do',
    '    case "$1" in',
    '      -c) shift; printf \'sql\\t%s\\n\' "$1" ;;',
    '      *) printf \'url\\t%s\\n\' "$1" ;;',
    '    esac',
    '    shift',
    '  done',
    '}; ',
  ].join('\n');

  interface FixRun {
    /** What the line left in `$DATABASE_POOLER` — already exported, or named by a refusal it fixes. */
    readonly exported: string | undefined;
    readonly statements: readonly string[];
    readonly url: string | undefined;
  }

  /**
   * The fix, run by a shell as printed. With `psql` present that is the real client, so the whole
   * line is proven end to end. Without it, the line still runs — only `psql` is a function — and
   * the statements it passed on are returned for the caller to send to the server itself, so the
   * claim never rests on which machine this ran on. Both stderr and the exit code are the shell's.
   */
  const runFix = async (fix: string, url: string): Promise<FixRun> => {
    const line = `${hasPsql ? '' : STUB_PSQL}${fix}\nprintf '%s' "$DATABASE_POOLER"`;
    const shell = Bun.spawnSync(['bash', '-c', line], {
      env: { PATH: process.env['PATH'] ?? '', DATABASE_URL: url },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    });
    expect(shell.stderr.toString()).toBe('');
    expect(shell.exitCode).toBe(0);
    const lines = shell.stdout.toString().split('\n');
    const word = (prefix: string): readonly string[] =>
      lines.filter((one) => one.startsWith(prefix)).map((one) => one.slice(prefix.length));
    return {
      exported: lines.at(-1),
      statements: word('sql\t'),
      url: word('url\t')[0],
    };
  };

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
    const shell = await runFix(fix, poolerUrl ?? '');
    const exported = shell.exported;
    expect(exported).toBe('transaction');
    if (!hasPsql) {
      // No `psql` here: the two `alter role` words the line handed it, sent to the server as it
      // would have sent them.
      expect(shell.statements).toHaveLength(2);
      for (const statement of shell.statements) await admin.execute(raw(statement));
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
    const shell = await runFix(fix, carrying.toString());
    if (!hasPsql) {
      // The `sed` in the line is the only thing between the fix and the option the pooler just
      // refused: assert what it was handed, then run the statement it passed on.
      expect(shell.url).toBeDefined();
      expect(shell.url ?? '').not.toContain('options=');
      for (const statement of shell.statements) await admin.execute(raw(statement));
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
