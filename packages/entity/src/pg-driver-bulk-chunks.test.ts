// A wide batch is one write. `insertAll`/`upsertAll` past the bind ceiling against a recording
// client, where the statement verbs are the claim: no `BEGIN` for one chunk, one transaction for
// two, a savepoint inside an open one, and always on the connection the repository is pinned to.
// The server's half, the rows left after a failure, is `pg-driver-bulk.live.test.ts`'s.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import {
  type DbClient,
  driverError,
  type RecordingClient,
  recordingClient,
  type SqlFragment,
  setDbClient,
  withTransaction,
} from '@ultimat3/db';
import { MAX_BIND_PARAMETERS } from './bulk-write';
import { text, uuid } from './columns';
import { entity } from './entity';
import { invariant } from './invariants';
import { postgresRepo } from './pg-driver';
import { allColumns } from './pg-row';
import { clearRegistry } from './registry';

const invoices = entity('pg_chunk_invoices', {
  columns: { id: uuid().primaryKey(), reference: text({ max: 40 }).unique(), note: text() },
});

/** A rule only the app can judge: the one thing that makes an upsert read back what it stored. */
const ruled = entity('pg_chunk_ruled', {
  columns: { id: uuid().primaryKey(), reference: text({ max: 40 }).unique(), note: text() },
  invariants: (c) => [
    invariant(
      'note_set',
      c.satisfies((note) => note !== '', ['note']),
    ),
  ],
});

type Invoice = typeof invoices.$row;

const invoice = (index: number): Invoice => ({
  id: `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
  reference: `INV-${index}`,
  note: 'n',
});

const partial = (values: Partial<Invoice>): Invoice => values as Invoice;

const COLUMNS = '("id", "reference", "note")';

let client: RecordingClient;

beforeEach(() => {
  client = recordingClient();
  setDbClient(client);
});

afterAll(() => {
  setDbClient(undefined);
  clearRegistry();
});

const repo = () => postgresRepo(invoices);
const lastText = (): string => client.texts.at(-1) ?? '';
const lastValues = (): readonly unknown[] => client.statements.at(-1)?.values ?? [];

const refusal = async (call: Promise<unknown>): Promise<{ code: string }> =>
  call.then(
    () => ({ code: 'resolved' }),
    (error: unknown) => ({ code: isUltimateError(error) ? error.code : String(error) }),
  );

describe('what holds the chunks of a batch together', () => {
  /** A batch one row past what one statement carries, so it is exactly two. */
  const justPastOneStatement = (): readonly Invoice[] => {
    const perStatement = Math.floor(MAX_BIND_PARAMETERS / allColumns(invoices).length);
    return Array.from({ length: perStatement + 1 }, (_, index) => invoice(index + 1000));
  };
  const verbs = (): readonly string[] =>
    client.texts.map((text) => text.split(' ')[0]?.toUpperCase() ?? '');

  test('one chunk is one autocommit statement, with no transaction around it', async () => {
    const perStatement = Math.floor(MAX_BIND_PARAMETERS / allColumns(invoices).length);
    await repo().insertAll(Array.from({ length: perStatement }, (_, i) => invoice(i + 1000)));

    expect(verbs()).toEqual(['INSERT']);
  });

  test('two chunks are one transaction: BEGIN, both inserts, COMMIT', async () => {
    await repo().insertAll(justPastOneStatement());

    expect(verbs()).toEqual(['BEGIN', 'INSERT', 'INSERT', 'COMMIT']);
  });

  test('a chunk the server refuses rolls the earlier one back and propagates', async () => {
    let inserts = 0;
    const refused = driverError('insert', { code: '23505', message: 'duplicate key' });
    const seen: string[] = [];
    const failing: DbClient = {
      ...client,
      query: async <T>(fragment: SqlFragment) => {
        seen.push(fragment.text);
        inserts += 1;
        if (inserts === 2) throw refused;
        return [] as T[];
      },
      execute: async (fragment: SqlFragment) => {
        seen.push(fragment.text);
        return 0;
      },
    };

    const pinned = postgresRepo(invoices, { client: failing });
    const outcome = await refusal(pinned.insertAll(justPastOneStatement()));

    expect(outcome.code).toBe('X_DB_UNIQUE_VIOLATION');
    expect(seen.map((text) => text.split(' ')[0]?.toUpperCase())).toEqual([
      'BEGIN',
      'INSERT',
      'INSERT',
      'ROLLBACK',
    ]);
  });

  test('inside an open transaction two chunks are a savepoint, never a second BEGIN', async () => {
    await withTransaction(() => repo().insertAll(justPastOneStatement()));

    expect(verbs()).toEqual(['BEGIN', 'SAVEPOINT', 'INSERT', 'INSERT', 'RELEASE', 'COMMIT']);
  });

  test('upsertAll past one chunk is the same one transaction', async () => {
    await repo().upsertAll(justPastOneStatement(), { onConflict: ['reference'] });

    expect(verbs()).toEqual(['BEGIN', 'INSERT', 'INSERT', 'COMMIT']);
  });

  test('an updating upsert with an app-only rule is judged in a transaction of its own', async () => {
    const judged = postgresRepo(ruled);
    const row = { id: invoice(1).id, reference: 'R', note: 'n' };
    client.on('insert into', { rows: [row] });

    await judged.upsertAll([row], { onConflict: ['reference'] });
    expect(verbs()).toEqual(['BEGIN', 'INSERT', 'COMMIT']);

    // `do nothing` merges nothing, and a rule-less entity has nothing to judge: one statement.
    client.reset();
    await judged.upsertAll([row], { onConflict: ['reference'], onMatch: 'nothing' });
    expect(verbs()).toEqual(['INSERT']);
    client.reset();
    await repo().upsertAll([invoice(1)], { onConflict: ['reference'] });
    expect(verbs()).toEqual(['INSERT']);
  });

  test('a repository pinned to another client is refused before anything opens', async () => {
    const other = recordingClient();
    const pinned = postgresRepo(invoices, { client: other });

    const outcome = await withTransaction(() => refusal(pinned.insertAll(justPastOneStatement())));

    expect(outcome.code).toBe('X_REPO_CLIENT_PINNED');
    expect(other.statements).toHaveLength(0);
  });

  test('a pinned repository opens its transaction on the pin, not on the ambient pool', async () => {
    const pin = recordingClient();
    await postgresRepo(invoices, { client: pin }).insertAll(justPastOneStatement());

    expect(pin.texts[0]?.toUpperCase()).toStartWith('BEGIN');
    expect(pin.texts.at(-1)?.toUpperCase()).toStartWith('COMMIT');
    expect(client.statements).toHaveLength(0);
  });

  test('rows naming no column at all still compile: every cell is `default`', async () => {
    // A column list of nothing is `insert into t () values ()`, a `42601` the framework wrote. The
    // only way to say "take every default" for two rows at once is to name the columns.
    const none = partial({});
    await repo().insertAll([none, none]);

    const defaults = 'default, default, default';
    expect(lastText()).toBe(
      `insert into "pg_chunk_invoices" ${COLUMNS} values (${defaults}), (${defaults}) returning *`,
    );
    expect(lastValues()).toEqual([]);
  });
});
