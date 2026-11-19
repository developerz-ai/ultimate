// Single responsibility: a migration refusal raised on the embedded development database names a
// command that runs there — no image to deploy, no `DATABASE_URL` for psql, no git history for a
// migration written a minute ago — and every other mode keeps the line it shipped with. Beside it,
// the hook `x db rollback` refuses through: asked under the lock, before the first `down`.

import { describe, expect, test } from 'bun:test';
import { recordingClient } from './fake';
import { type LedgerRow, type Migration, migrationChecksum, rollback } from './migrate';
import { ledgerAheadOfBuild } from './migrate-rollback';
import { embeddedDev, embeddedResetFix } from './migration-errors';
import { auditLedger } from './migration-ledger';

const posts: Migration = {
  id: '20260101000000_posts',
  name: 'posts',
  up: 'create table "posts" ("id" uuid primary key);',
  down: 'drop table "posts";',
};

const row = (id: string, checksum: string, destructive = false): LedgerRow => ({
  id,
  name: id.slice(15),
  checksum,
  applied_at: '2026-01-01T00:00:00.000Z',
  app_version: 'dev',
  duration_ms: 4,
  destructive,
});

const KEYS = ['ULTIMATE_ENV', 'NODE_ENV', 'DATABASE_URL'] as const;

/** `run` under exactly these three keys, then the process's own back — the readers are ambient. */
async function under<T>(
  env: Partial<Record<(typeof KEYS)[number], string>>,
  run: () => T | Promise<T>,
): Promise<T> {
  const before = KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of KEYS) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const DEV = { ULTIMATE_ENV: 'development' } as const;
const PRODUCTION = { ULTIMATE_ENV: 'production', DATABASE_URL: 'postgres://db/app' } as const;

const fixOf = async (run: () => unknown): Promise<{ code: string; fix: string }> => {
  try {
    await run();
  } catch (error) {
    return error as { code: string; fix: string };
  }
  return expect.unreachable('the ledger was accepted, and this test needs its refusal');
};

describe('unit · which database a migration refusal is about', () => {
  test('development with no DATABASE_URL is the embedded one; anything else is not', () => {
    expect(embeddedDev({ ULTIMATE_ENV: 'development' })).toBe(true);
    expect(embeddedDev({ ULTIMATE_ENV: 'development', DATABASE_URL: '  ' })).toBe(true);
    expect(embeddedDev({ ULTIMATE_ENV: 'development', DATABASE_URL: 'postgres://x/y' })).toBe(
      false,
    );
    expect(embeddedDev({ ULTIMATE_ENV: 'production' })).toBe(false);
    expect(embeddedDev({ ULTIMATE_ENV: 'staging' })).toBe(false);
    // A typo is not a development machine: the deploy's own lines stay.
    expect(embeddedDev({ ULTIMATE_ENV: 'prodution' })).toBe(false);
  });

  test('the reset line stops a running x dev first, and says what it costs', () => {
    const fix = embeddedResetFix('its file is gone');
    expect(fix).toStartWith('x stop --json && x db reset   # ');
    expect(fix).toContain('its file is gone');
    expect(fix).toContain('rows');
  });
});

describe('unit · X_MIGRATION_CONFLICT on the embedded development database', () => {
  const foreign = (): unknown => auditLedger([row('20260301000000_gone', 'abc')], [posts], 'dev');
  const edited = (): unknown => auditLedger([row(posts.id, 'not-this-one')], [posts], 'dev');

  test('a row this checkout does not ship: reset, never psql against an empty DATABASE_URL', async () => {
    const { code, fix } = await under(DEV, () => fixOf(foreign));
    expect(code).toBe('X_MIGRATION_CONFLICT');
    expect(fix).toStartWith('x stop --json && x db reset   # ');
    expect(fix).not.toContain('DATABASE_URL');
  });

  test('the same row in production keeps the psql line', async () => {
    const { fix } = await under(PRODUCTION, () => fixOf(foreign));
    expect(fix).toContain('psql "$DATABASE_URL" -c "delete from x_migrations');
  });

  test('an edited migration: reset re-applies it, and git is the alternative, not the command', async () => {
    const { code, fix } = await under(DEV, () => fixOf(edited));
    expect(code).toBe('X_MIGRATION_CONFLICT');
    expect(fix).toStartWith('x stop --json && x db reset   # ');
    expect((fix.split('#')[0] ?? '').includes('git log')).toBe(false);
    expect(fix).toContain(
      `git log --format='%h %ad %s' --date=short -- packages/db/migrations/${posts.id}.sql`,
    );
  });

  test('the same edit in production still leads with the revisions', async () => {
    const { fix } = await under(PRODUCTION, () => fixOf(edited));
    expect(fix).toStartWith("git log --format='%h %ad %s'");
  });

  test('a rollback whose down SQL is gone: reset, never psql', async () => {
    const client = recordingClient();
    client.on(/pg_try_advisory_lock/, { rows: [{ locked: true }] });
    client.on(/from x_migrations/, { rows: [row('20260301000000_gone', 'abc')] });
    const { code, fix } = await under(DEV, () =>
      fixOf(() => rollback({ migrations: [posts], client })),
    );
    expect(code).toBe('X_MIGRATION_CONFLICT');
    expect(fix).toStartWith('x stop --json && x db reset   # ');
    expect(fix).not.toContain('DATABASE_URL');
  });
});

describe('unit · X_MIGRATION_ROLLBACK_DESTRUCTIVE on the embedded development database', () => {
  const ahead = (): unknown =>
    ledgerAheadOfBuild(
      [row(posts.id, migrationChecksum(posts)), row('20260301000000_drop_closed_at', 'abc', true)],
      [posts],
      { allow: '' },
    );

  test('there is no image to deploy: the fix resets, and names rollback for a restored file', async () => {
    const { code, fix } = await under(DEV, () => fixOf(ahead));
    expect(code).toBe('X_MIGRATION_ROLLBACK_DESTRUCTIVE');
    expect(fix).toStartWith('x stop --json && x db reset   # ');
    expect(fix).not.toContain('x deploy');
    expect(fix).toContain('x db rollback');
  });

  test('production keeps the roll-forward and the written override', async () => {
    const { fix } = await under(PRODUCTION, () => fixOf(ahead));
    expect(fix).toStartWith('x deploy --image <the newer image> --json');
    expect(fix).toContain('ROLLBACK_ALLOW_DESTRUCTIVE=20260301000000_drop_closed_at');
  });
});

describe('unit · rollback({ confirm })', () => {
  const applied = (): ReturnType<typeof recordingClient> => {
    const client = recordingClient();
    client.on(/from x_migrations/, { rows: [row(posts.id, migrationChecksum(posts))] });
    return client;
  };

  test('is handed the exact rows about to be reversed, before any down runs', async () => {
    const client = applied();
    const seen: string[][] = [];
    const reverted = await rollback({
      migrations: [posts],
      client,
      confirm: (targets) => {
        seen.push(targets.map((target) => target.id));
        expect(client.statements.some((statement) => /drop table/.test(statement.text))).toBe(
          false,
        );
      },
    });
    expect(seen).toEqual([[posts.id]]);
    expect(reverted).toEqual([posts.id]);
  });

  test('a confirm that throws reverses nothing, and the lock is given back', async () => {
    const client = applied();
    const refusal = Object.assign(new TypeError('not named'), { code: 'X_TEST' });
    const { code } = await fixOf(() =>
      rollback({
        migrations: [posts],
        client,
        confirm: () => {
          throw refusal;
        },
      }),
    );
    expect(code).toBe('X_TEST');
    const sent = client.statements.map((statement) => statement.text).join('\n');
    expect(sent).not.toContain('drop table');
    expect(sent).not.toContain('delete from');
    expect(sent).toContain('pg_advisory_unlock');
  });
});
