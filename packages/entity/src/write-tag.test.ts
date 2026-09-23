// A keyed request's write names itself in the WAL: the message opens the transaction the write
// lands in, once per transaction, and nothing about a write outside a keyed request changes.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createContext,
  runWithContext,
  userActor,
  WRITE_ORIGIN_WAL_PREFIX,
  withWriteOrigin,
} from '@ultimat3/core';
import { createRecordingClient, type RecordingClient, setDbClient } from '@ultimat3/db';
import { text, uuid } from './columns';
import { entity } from './entity';
import { postgresRepo } from './pg-driver';
import { postgresTransactor } from './pg-transactor';
import { clearRegistry } from './registry';
import { resetWriteTag } from './write-tag';

const notes = entity('write_tag_notes', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), title: text({ max: 40 }) },
});

const ORG = '00000000-0000-7000-8000-0000000000a1';
const ONE = '00000000-0000-7000-8000-000000000101';
const TWO = '00000000-0000-7000-8000-000000000102';
const WRITE = 'f'.repeat(32);

let client: RecordingClient;

beforeEach(() => {
  resetWriteTag();
  client = createRecordingClient();
  client.on('insert into', { rows: [{ id: ONE, org_id: ORG, title: 't' }] });
  setDbClient(client);
});

afterAll(() => {
  resetWriteTag();
  setDbClient(undefined);
});

const asMember = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(createContext({ actor: userActor({ id: 'm1', orgId: ORG, roles: [] }) }), work);

const insert = (id: string, repo = postgresRepo(notes)) =>
  repo.insert({ id, orgId: ORG, title: 't' });

const grants = (ok: boolean): void => {
  client.on('has_function_privilege', { rows: [{ ok }] });
};

/** The statement kinds, in order: what a reader of the WAL would see this process send. */
const kinds = (): string[] =>
  client.texts.map((sql) => {
    if (sql.includes('has_function_privilege')) return 'probe';
    if (sql.includes('pg_logical_emit_message')) return 'emit';
    if (sql.startsWith('insert into')) return 'insert';
    return sql;
  });

describe('a keyed write, named in the WAL', () => {
  test('outside a keyed request the write is exactly what it was', async () => {
    grants(true);
    await asMember(() => insert(ONE));
    expect(kinds()).toEqual(['insert']);
  });

  test('outside a transaction it gets one of its own, opened by the message', async () => {
    grants(true);
    await asMember(() => withWriteOrigin(WRITE, () => insert(ONE)));
    expect(kinds()).toEqual(['probe', 'BEGIN', 'emit', 'insert', 'COMMIT']);
    const emitted = client.statements.find((s) => s.text.startsWith('select pg_logical_emit'));
    expect(emitted?.values).toEqual([WRITE_ORIGIN_WAL_PREFIX, WRITE]);
  });

  test('inside an open transaction the message goes first, and only once', async () => {
    grants(true);
    await asMember(() =>
      withWriteOrigin(WRITE, () =>
        postgresTransactor().run(async () => {
          await insert(ONE);
          await insert(TWO);
        }),
      ),
    );
    expect(kinds()).toEqual(['BEGIN', 'probe', 'emit', 'insert', 'insert', 'COMMIT']);
  });

  test('the capability is asked once per process, not once per write', async () => {
    grants(true);
    await asMember(() => withWriteOrigin(WRITE, () => insert(ONE)));
    await asMember(() => withWriteOrigin(WRITE, () => insert(TWO)));
    expect(kinds().filter((kind) => kind === 'probe')).toHaveLength(1);
    expect(kinds().filter((kind) => kind === 'emit')).toHaveLength(2);
  });

  test('a role that may not emit costs the page its echo, never the write', async () => {
    grants(false);
    await asMember(() => withWriteOrigin(WRITE, () => insert(ONE)));
    expect(kinds()).toEqual(['probe', 'insert']);
  });

  test('a repository pinned to its own client is never wrapped', async () => {
    grants(true);
    const shard = createRecordingClient();
    shard.on('insert into', { rows: [{ id: ONE, org_id: ORG, title: 't' }] });
    await asMember(() =>
      withWriteOrigin(WRITE, () => insert(ONE, postgresRepo(notes, { client: shard }))),
    );
    expect(client.texts).toEqual([]);
    expect(shard.texts.map((sql) => sql.split(' ')[0])).toEqual(['insert']);
  });
});

afterAll(() => {
  clearRegistry();
});
