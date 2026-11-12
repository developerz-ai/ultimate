// The count-only write paths against recording clients: `insert … ` with no `returning`, chunked
// and all-or-nothing as `writeChunks` is; `copyRows` as one `COPY` when the client can take one
// and the same count-only insert when it cannot; and `copyColumns` refusing a batch COPY cannot
// spell. The server's half is `pg-copy.live.test.ts`'s.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import {
  type RecordingClient,
  recordingClient,
  type SqlFragment,
  setDbClient,
  setTransactionSettings,
} from '@ultimat3/db';
import { insertChunks, MAX_BIND_PARAMETERS, statementColumns } from './bulk-write';
import { countChunks } from './bulk-write-send';
import { text, uuid } from './columns';
import { copyColumns } from './copy-plan';
import { entity } from './entity';
import { invariant } from './invariants';
import { copyRows } from './pg-copy';
import { bindValues } from './pg-row';
import { insertStatement } from './pg-write-sql';
import { clearRegistry } from './registry';

const notes = entity('pg_copy_notes', {
  columns: {
    id: uuid().primaryKey(),
    reference: text({ max: 40 }).unique(),
    body: text().nullable(),
  },
});

const ruled = entity('pg_copy_ruled', {
  columns: { id: uuid().primaryKey(), reference: text({ max: 40 }).unique(), body: text() },
  invariants: (c) => [
    invariant(
      'body_set',
      c.satisfies((body) => body !== '', ['body']),
    ),
  ],
});

type Note = typeof notes.$row;

const note = (index: number, body: string | null = 'b'): Note => ({
  id: `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
  reference: `N-${index}`,
  body,
});

const bound = (rows: readonly Note[]) => rows.map((row) => bindValues(notes, row));

/** A recording client that also takes a copy, keeping each target and its rows. */
const copying = (client: RecordingClient) => {
  const copies: { readonly text: string; readonly rows: (readonly unknown[])[] }[] = [];
  return {
    copies,
    client: Object.assign(client, {
      async copyIn(target: SqlFragment, rows: Iterable<readonly unknown[]>) {
        const held = [...rows];
        copies.push({ text: target.text, rows: held });
        return held.length;
      },
    }),
  };
};

let client: RecordingClient;

beforeEach(() => {
  client = recordingClient();
  setDbClient(client);
});

afterAll(() => {
  setDbClient(undefined);
  setTransactionSettings(undefined);
  clearRegistry();
});

describe('insertStatement · returning', () => {
  test('false writes no returning clause; absent keeps returning *', () => {
    const rows = bound([note(1)]);
    const columns = statementColumns(notes, [note(1)]);
    expect(insertStatement(notes, rows, { columns }).text).toEndWith(' returning *');
    expect(insertStatement(notes, rows, { columns, returning: false }).text).not.toContain(
      'returning',
    );
  });
});

describe('countChunks', () => {
  test('one chunk: one statement, no returning, the command tag is the answer', async () => {
    client.on(/^insert/, { affected: 3 });
    const rows = [note(1), note(2), note(3)];
    const shape = { columns: statementColumns(notes, rows), returning: false } as const;
    expect(await countChunks(notes, bound(rows), shape, client, undefined)).toBe(3);
    expect(client.texts).toHaveLength(1);
    expect(client.texts[0]).not.toContain('returning');
  });

  test('past the bind ceiling: every chunk inside one transaction, the counts summed', async () => {
    const width = 3;
    const perChunk = Math.floor(MAX_BIND_PARAMETERS / width);
    const rows = Array.from({ length: perChunk + 2 }, (_, index) => note(index));
    client.on(/^insert/, { affected: 1 });
    const shape = { columns: statementColumns(notes, rows), returning: false } as const;
    expect(insertChunks(rows, width)).toHaveLength(2);
    expect(await countChunks(notes, bound(rows), shape, client, undefined)).toBe(2);
    const verbs = client.texts.map((sent) => sent.split(' ')[0]?.toLowerCase());
    expect(verbs).toEqual(['begin', 'insert', 'insert', 'commit']);
  });

  test('an updating upsert with an app-only rule still reads back to judge, then counts', async () => {
    const rows = [{ id: note(1).id, reference: 'N-1', body: '' }];
    client.on(/^insert/, { rows });
    const shape = {
      columns: statementColumns(ruled, rows),
      conflict: { columns: ['reference'], set: ['body'] },
      returning: false,
    } as const;
    try {
      await countChunks(
        ruled,
        rows.map((row) => bindValues(ruled, row)),
        shape,
        client,
        undefined,
      );
      expect.unreachable('the merged row breaks body_set');
    } catch (error) {
      expect(isUltimateError(error) && error.code).toBe('X_INVARIANT_VIOLATED');
    }
    expect(client.texts.some((sent) => sent.includes('returning *'))).toBe(true);
  });
});

describe('copyRows', () => {
  test('a client that copies: one COPY, the cells in column order, nothing else sent', async () => {
    const { client: on, copies } = copying(client);
    const rows = [note(1), note(2, null)];
    const columns = ['id', 'reference', 'body'];
    expect(await copyRows(notes, bound(rows), columns, on, undefined)).toBe(2);
    expect(copies).toHaveLength(1);
    expect(copies[0]?.text).toBe('copy "pg_copy_notes" ("id", "reference", "body") from stdin');
    expect(copies[0]?.rows[1]).toEqual([note(2).id, 'N-2', null]);
    expect(client.texts).toEqual([]);
  });

  test('a client that cannot copy: the count-only insert, same rows', async () => {
    client.on(/^insert/, { affected: 2 });
    const rows = [note(1), note(2)];
    expect(await copyRows(notes, bound(rows), ['id', 'reference', 'body'], client, undefined)).toBe(
      2,
    );
    expect(client.texts).toHaveLength(1);
    expect(client.texts[0]).toStartWith('insert into "pg_copy_notes"');
    expect(client.texts[0]).not.toContain('returning');
  });

  test('row security engaged: falls back, so the insert rides the tenant BEGIN', async () => {
    const { client: on, copies } = copying(client);
    setTransactionSettings(() => ({ 'x.tenant': 'acme' }));
    client.on(/^insert/, { affected: 1 });
    expect(await copyRows(notes, bound([note(1)]), ['id', 'reference'], on, undefined)).toBe(1);
    setTransactionSettings(undefined);
    expect(copies).toHaveLength(0);
  });

  test('no column named at all: COPY cannot spell all-defaults, the insert can', async () => {
    const { client: on, copies } = copying(client);
    client.on(/^insert/, { affected: 1 });
    const empty = [new Map<string, unknown>()];
    expect(await copyRows(notes, empty, [], on, undefined)).toBe(1);
    expect(copies).toHaveLength(0);
    expect(client.texts[0]).toContain('values (default');
  });

  test('an empty batch sends nothing', async () => {
    const { client: on, copies } = copying(client);
    expect(await copyRows(notes, [], ['id'], on, undefined)).toBe(0);
    expect(copies).toHaveLength(0);
    expect(client.texts).toEqual([]);
  });
});

describe('copyColumns', () => {
  test('the properties every row writes, in declaration order', () => {
    expect(copyColumns(notes, [{ reference: 'a', id: note(1).id }])).toEqual(['id', 'reference']);
  });

  test('a column one row writes and another omits is refused, naming the row and the column', () => {
    try {
      copyColumns(notes, [
        { id: note(1).id, reference: 'a', body: 'x' },
        { id: note(2).id, reference: 'b', body: undefined },
      ]);
      expect.unreachable('row 2 leaves body out');
    } catch (error) {
      expect(isUltimateError(error) && error.code).toBe('X_INVARIANT_VIOLATED');
      expect(String((error as Error).message)).toContain('row 2');
      expect(String((error as Error).message)).toContain('"body"');
    }
  });
});
