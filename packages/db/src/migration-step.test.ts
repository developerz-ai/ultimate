// What `migrate()` and `rollback()` send for a `-- transaction: false` migration, on a recording
// client: no `BEGIN`, no `SET LOCAL`, the statements one at a time, the INVALID-leftover lookup in
// front of each named concurrent build, and the ledger write LAST. And the refusal a concurrent
// statement earns in a migration that would run inside a transaction. A real engine applying all
// of it is `concurrent-index-embedded.test.ts`.

import { beforeEach, describe, expect, test } from 'bun:test';
import { setDbClient } from './client';
import { type RecordingClient, recordingClient } from './fake';
import { type Migration, migrate, rollback } from './migrate';

const outside: Migration = {
  id: '20261031120000_index_status',
  name: 'index status',
  up:
    '-- transaction: false\n' +
    'create index concurrently if not exists "runs_status_idx" on "runs" ("status");\n' +
    'drop index concurrently if exists "runs_old_idx";',
  down:
    'create index concurrently if not exists "runs_old_idx" on "runs" ("old");\n' +
    'drop index concurrently if exists "runs_status_idx";',
};

let client: RecordingClient;

beforeEach(() => {
  client = recordingClient();
  setDbClient(client);
});

const position = (match: string): number => client.texts.findIndex((text) => text.includes(match));

describe('unit · a `-- transaction: false` migration', () => {
  test('applies statement by statement, outside a transaction, and records itself last', async () => {
    const report = await migrate({ migrations: [outside], appVersion: 'test', client });

    expect(report.applied.map((each) => each.id)).toEqual([outside.id]);
    expect(client.texts).not.toContain('BEGIN');
    expect(client.texts).not.toContain('COMMIT');
    // `lock_timeout` would turn the build's long-but-harmless wait for old transactions into an
    // INVALID index; the concurrent forms queue no read and no write, so none is set.
    expect(client.texts.some((text) => text.includes('lock_timeout'))).toBe(false);
    const build = position('create index concurrently if not exists "runs_status_idx"');
    const drop = position('drop index concurrently if exists "runs_old_idx"');
    const ledger = position('insert into x_migrations');
    expect(build).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(build);
    // The ledger row only after the last statement succeeded: a step that failed half-way has no
    // row, and re-running it is safe because every statement in it is `if [not] exists`.
    expect(ledger).toBeGreaterThan(drop);
  });

  test('looks up the build it is about to run, and leaves a VALID index alone', async () => {
    client.on(/pg_index/, { rows: [{ valid: true }] });
    await migrate({ migrations: [outside], appVersion: 'test', client });

    const lookup = client.statements.find((each) => each.text.includes('to_regclass'));
    // The name exactly as the statement spells it — what `to_regclass` resolves.
    expect(lookup?.values).toEqual(['"runs_status_idx"']);
    expect(position('to_regclass')).toBeLessThan(position('create index concurrently'));
    expect(client.texts.filter((text) => text.startsWith('drop index concurrently'))).toEqual([
      'drop index concurrently if exists "runs_old_idx"',
    ]);
  });

  test('drops an INVALID leftover concurrently, right before building it again', async () => {
    client.on(/pg_index/, { rows: [{ valid: false }] });
    await migrate({ migrations: [outside], appVersion: 'test', client });

    const leftover = position('drop index concurrently if exists "runs_status_idx"');
    expect(leftover).toBeGreaterThan(position('to_regclass'));
    expect(leftover).toBeLessThan(position('create index concurrently'));
  });

  test('a rollback reverses it outside a transaction too — the marker on `up` governs `down`', async () => {
    client.on(/from x_migrations/, {
      rows: [
        {
          id: outside.id,
          name: outside.name,
          checksum: 'x',
          applied_at: '2026-10-31T12:00:00.000Z',
          app_version: 'test',
          duration_ms: 1,
        },
      ],
    });
    const reverted = await rollback({ migrations: [outside], client });

    expect(reverted).toEqual([outside.id]);
    expect(client.texts).not.toContain('BEGIN');
    const rebuilt = position('create index concurrently if not exists "runs_old_idx"');
    expect(rebuilt).toBeGreaterThan(-1);
    expect(position('delete from x_migrations')).toBeGreaterThan(rebuilt);
  });
});

describe('unit · a statement in the step that is NOT a concurrent build', () => {
  test('runs in a short transaction of its own, under the migration lock_timeout', async () => {
    // `alter table … drop constraint` takes ACCESS EXCLUSIVE: unbounded, it would queue every
    // read and write of the table behind one long reader. The concurrent builds around it keep
    // running without a bound, outside any transaction.
    const contract: Migration = {
      id: '20261031120000_drop_key',
      name: 'drop key',
      up:
        '-- transaction: false\n' +
        'create unique index concurrently if not exists "runs_bank_key" on "runs" ("bank");\n' +
        'alter table "runs" drop constraint if exists "runs_ref_key";\n' +
        'drop index concurrently if exists "runs_ref_key";',
      down: '',
    };
    await migrate({ migrations: [contract], appVersion: 'test', client, lockTimeoutMs: 3_000 });

    const begin = client.texts.indexOf('BEGIN');
    const timeout = position('SET LOCAL lock_timeout = 3000');
    const alter = position('drop constraint if exists "runs_ref_key"');
    const commit = client.texts.indexOf('COMMIT');
    const drop = position('drop index concurrently if exists "runs_ref_key"');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(timeout).toBeGreaterThanOrEqual(0);
    expect(alter).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(begin).toBeGreaterThan(position('create unique index concurrently'));
    expect([begin, timeout, alter, commit]).toEqual(
      [...[begin, timeout, alter, commit]].sort((a, b) => a - b),
    );
    expect(commit).toBeLessThan(drop);
    expect(client.texts.filter((text) => text === 'BEGIN')).toHaveLength(1);
  });
});

describe('unit · a concurrent statement in a transactional migration', () => {
  test('is refused before BEGIN, naming the migration and the marker', async () => {
    const inside: Migration = {
      id: '20261031120000_hand_written',
      name: 'hand written',
      up: 'create index concurrently "runs_bank_idx" on "runs" ("bank");',
      down: 'drop index concurrently "runs_bank_idx";',
    };

    const refusal = await migrate({ migrations: [inside], appVersion: 'test', client }).then(
      () => undefined,
      (error: unknown) => error as { code?: string; cause?: string; fix?: string },
    );

    expect(refusal?.code).toBe('X_MIGRATION_CONCURRENT_IN_TRANSACTION');
    expect(refusal?.cause).toContain('20261031120000_hand_written');
    expect(refusal?.cause).toContain('create index concurrently "runs_bank_idx"');
    expect(refusal?.fix).toBe(
      "sed -i '1i -- transaction: false' packages/db/migrations/20261031120000_hand_written.sql" +
        '   # before it is applied — or move the statement into a migration of its own',
    );
    expect(client.texts).not.toContain('BEGIN');
    expect(client.texts.some((text) => text.includes('create index'))).toBe(false);
    expect(client.texts.some((text) => text.includes('insert into x_migrations'))).toBe(false);
  });

  test('an id a shell would read is left out of the command', async () => {
    const hostile: Migration = {
      id: '20261031120000_$(touch pwned)',
      name: 'x',
      up: 'drop index concurrently "runs_bank_idx";',
      down: '',
    };
    const refusal = await migrate({ migrations: [hostile], appVersion: 'test', client }).then(
      () => undefined,
      (error: unknown) => error as { code?: string; fix?: string },
    );

    expect(refusal?.code).toBe('X_MIGRATION_CONCURRENT_IN_TRANSACTION');
    expect(refusal?.fix).not.toContain('$(');
    expect(refusal?.fix).toContain('packages/db/migrations/<id>.sql');
  });
});
