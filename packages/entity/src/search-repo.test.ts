// `.search(term)` asks the INSTALLED index: the built-in one stays the statement's own `matches`
// predicate (so the memory driver still refuses it), any other one answers ids the chain then reads.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { recordingClient } from '@ultimat3/db';
import { text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { MAX_PAGE_SIZE } from './plan';
import { tableFor } from './query';
import { clearRegistry } from './registry';
import type { SearchIndex } from './search-index';
import { searchDocumentOf, searchLimitOf } from './search-index';
import { installSearchIndex } from './search-index-installed';
import { memorySearchIndex } from './search-index-memory';

afterAll(() => {
  clearRegistry();
});

const ORG_A = '00000000-0000-7000-8000-00000000000a';
const ORG_B = '00000000-0000-7000-8000-00000000000b';
const id = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const notes = entity('srepo_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text().searchable('A'),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
});

const AT = new Date('2026-11-09T10:00:00.000Z');
const ROWS = [
  { id: id(1), orgId: ORG_A, title: 'zebra crossing', updatedAt: AT },
  { id: id(2), orgId: ORG_A, title: 'quokka', updatedAt: AT },
  { id: id(3), orgId: ORG_B, title: 'zebra', updatedAt: AT },
];

let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
});

const codeOf = async (pending: Promise<unknown>): Promise<string> =>
  pending.then(
    () => 'answered',
    (error: unknown) => (isUltimateError(error) ? error.code : `not coded: ${String(error)}`),
  );

const memoryTable = async () => {
  const table = tableFor(notes, memoryRepo(notes));
  await table.insertAll(ROWS);
  return table;
};

describe('.search() through the installed index', () => {
  test('the built-in index is the statement: the memory driver still refuses it', async () => {
    const table = await memoryTable();
    expect(await codeOf(table.where({ orgId: ORG_A }).search('zebra').all())).toBe(
      'X_SEARCH_IN_MEMORY',
    );
  });

  test('the built-in index keeps today’s SQL: one statement, the match inside it', async () => {
    const client = recordingClient();
    await tableFor(notes, postgresRepo(notes, { client }))
      .where({ orgId: ORG_A })
      .search('zebra')
      .all();
    expect(client.texts.filter((text) => text.includes('websearch_to_tsquery')).length).toBe(1);
  });

  test("another index answers the ids, scoped to the chain's tenant", async () => {
    const index = memorySearchIndex();
    release = installSearchIndex(index);
    await index.index(ROWS.map((row) => searchDocumentOf(notes, row)));
    const table = await memoryTable();
    const found = await table.where({ orgId: ORG_A }).search('zebra').all();
    expect(found.map((row) => row.id)).toEqual([id(1)]);
    expect(await table.where({ orgId: ORG_A }).search('zebra').count()).toBe(1);
    expect(await table.where({ orgId: ORG_B }).search('zebra').count()).toBe(1);
    expect(await table.where({ orgId: ORG_A }).search('walrus').all()).toEqual([]);
  });

  test('a search matching more than MAX_PAGE_SIZE rows is refused, never truncated', async () => {
    // An index holding `total` matches, answering as many as each query asks for — as any
    // conforming adapter does. The rows behind them are the recording client's: no table needed.
    const holding = (total: number): SearchIndex => ({
      ...memorySearchIndex(),
      query: async (query) =>
        Array.from({ length: Math.min(total, searchLimitOf(query)) }, (_, n) => ({ id: id(n) })),
    });
    const client = recordingClient();
    const chain = () =>
      tableFor(notes, postgresRepo(notes, { client })).where({ orgId: ORG_A }).search('apple');
    release = installSearchIndex(holding(MAX_PAGE_SIZE + 50));
    for (const read of [
      chain().count(),
      chain().countBy('orgId'),
      chain().max('updatedAt'),
      chain().limit(20).all(),
    ]) {
      const refused = await read.then(
        () => null,
        (error: unknown) => error,
      );
      expect(isUltimateError(refused) ? [refused.code, refused.message] : refused).toEqual([
        'X_INVARIANT_VIOLATED',
        expect.stringContaining(`${MAX_PAGE_SIZE} or more`),
      ]);
    }
    expect(client.statements).toEqual([]);
    release();
    // One hit under the bound is an answer, and every hit reaches the statement.
    release = installSearchIndex(holding(MAX_PAGE_SIZE - 1));
    await chain().count();
    expect(client.statements.map((each) => each.values.flat().length)).toEqual([
      MAX_PAGE_SIZE - 1 + 1,
    ]);
  });
});
