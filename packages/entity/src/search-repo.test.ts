// `.search(term)` asks the INSTALLED index: the built-in one stays the statement's own `matches`
// predicate (so the memory driver still refuses it), any other one answers ids the chain then reads.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { recordingClient } from '@ultimat3/db';
import { text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { tableFor } from './query';
import { clearRegistry } from './registry';
import { searchDocumentOf } from './search-index';
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
});
