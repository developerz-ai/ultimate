// What the search mirror costs a Postgres write, as statement text: a delete or filtered write of a
// searchable entity under an EXTERNAL index answers its rows (`returning *`), and the rows reach the
// index; under the built-in index, or for an entity with nothing searchable, the statement is the
// one it always was — a count, no rows on the wire.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, installLogSink, runWithContext, userActor } from '@ultimat3/core';
import { type RecordingClient, recordingClient, setDbClient } from '@ultimat3/db';
import { text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { MAX_ASSERTED_ROWS } from './invariants';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';
import { observedRepo } from './row-observer';
import type { SearchIndex, SearchScope } from './search-index';
import { installSearchIndex } from './search-index-installed';
import { memorySearchIndex } from './search-index-memory';
import { postgresSearchIndex } from './search-index-postgres';
import { SEARCH_INDEX_WRITE_FAILED } from './search-index-sync';

afterAll(() => {
  setDbClient(undefined);
  clearRegistry();
});

const ORG = '00000000-0000-7000-8000-00000000000a';
const ID = '00000000-0000-7000-8000-000000000001';

const notes = entity('smstmt_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text().searchable(),
    shelf: text(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
});

const plain = entity('smstmt_plain', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), shelf: text() },
});

const STORED = {
  id: ID,
  org_id: ORG,
  title: 'zebra',
  shelf: 'old',
  updated_at: '2026-11-10T10:00:00.000Z',
};

let client: RecordingClient;
let release: (() => void) | undefined;
beforeEach(() => {
  client = recordingClient();
  setDbClient(client);
});
afterEach(() => {
  release?.();
  release = undefined;
});

const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'member-1', orgId: ORG }) }), fn);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const lastText = (): string => client.texts.at(-1) ?? '';

/** Records every removal, so a test reads what the mirror sent. */
const removals = (): SearchIndex & { readonly removed: [SearchScope, readonly string[]][] } => {
  const inner = memorySearchIndex();
  const removed: [SearchScope, readonly string[]][] = [];
  return {
    ...inner,
    name: 'recording',
    removed,
    remove: async (scope, ids, version) => {
      removed.push([scope, ids]);
      await inner.remove(scope, ids, version);
    },
  };
};

describe('the search mirror, as statements', () => {
  test('under the built-in index a filtered write stays a count: no returning', async () => {
    release = installSearchIndex(postgresSearchIndex());
    const repo = observedRepo(notes, postgresRepo(notes));
    await asMember(() => repo.deleteWhere({ shelf: 'old' }));
    expect(lastText()).not.toContain('returning');
    await asMember(() => repo.updateWhere({ shelf: 'old' }, { title: 'quokka' }));
    expect(lastText()).not.toContain('returning');
  });

  test('an entity with nothing searchable sends no returning under an external index', async () => {
    release = installSearchIndex(memorySearchIndex());
    const repo = observedRepo(plain, postgresRepo(plain));
    await asMember(() => repo.deleteWhere({ shelf: 'old' }));
    expect(lastText()).not.toContain('returning');
  });

  test('under an external index deleteWhere answers its rows, and they are removed', async () => {
    const index = removals();
    release = installSearchIndex(index);
    client.on(/^delete from/, { rows: [STORED] });
    const repo = observedRepo(notes, postgresRepo(notes));
    expect(await asMember(() => repo.deleteWhere({ shelf: 'old' }))).toBe(1);
    expect(lastText()).toEndWith('returning *');
    await settle();
    expect(index.removed).toEqual([[{ entity: notes.$name, tenant: ORG }, [ID]]]);
  });

  test('under an external index updateWhere answers its rows, and they are indexed', async () => {
    const index = memorySearchIndex();
    release = installSearchIndex(index);
    client.on(/^update/, { rows: [{ ...STORED, title: 'quokka' }] });
    const repo = observedRepo(notes, postgresRepo(notes));
    expect(await asMember(() => repo.updateWhere({ shelf: 'old' }, { title: 'quokka' }))).toBe(1);
    expect(lastText()).toEndWith('returning *');
    await settle();
    const hits = await index.query({ entity: notes.$name, tenant: ORG, term: 'quokka' });
    expect(hits).toEqual([{ id: ID }]);
  });

  test('past MAX_ASSERTED_ROWS a filtered write stays a count, and says it was not mirrored', async () => {
    const index = removals();
    release = installSearchIndex(index);
    client.on(/^select count/, { rows: [{ count: String(MAX_ASSERTED_ROWS + 1) }] });
    client.on(/^delete from/, { affected: MAX_ASSERTED_ROWS + 1 });
    const lines: string[] = [];
    const restore = installLogSink((line) => {
      lines.push(line);
    });
    try {
      const repo = observedRepo(notes, postgresRepo(notes));
      expect(await asMember(() => repo.deleteWhere({ shelf: 'old' }))).toBe(MAX_ASSERTED_ROWS + 1);
      expect(lastText()).not.toContain('returning');
      await settle();
    } finally {
      restore();
    }
    expect(index.removed).toEqual([]);
    expect(lines.some((line) => line.includes(SEARCH_INDEX_WRITE_FAILED))).toBe(true);
  });
});
