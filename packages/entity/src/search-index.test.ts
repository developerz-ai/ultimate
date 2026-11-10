import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { recordingClient } from '@ultimat3/db';
import { text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { clearRegistry } from './registry';
import { searchDocumentOf, searchLimitOf } from './search-index';
import { installSearchIndex, searchIndex } from './search-index-installed';
import { memorySearchIndex, searchWords } from './search-index-memory';
import { postgresSearchIndex } from './search-index-postgres';

afterAll(() => {
  clearRegistry();
});

const ORG = '00000000-0000-7000-8000-00000000000a';
const ID = '00000000-0000-7000-8000-000000000001';

const posts = entity('sidx_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text().searchable('A'),
    body: text().nullable().searchable(),
    secretNote: text(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
});

const shared = entity('sidx_shared', {
  columns: {
    id: uuid().primaryKey(),
    title: text().searchable(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
});

const unversioned = entity('sidx_unversioned', {
  columns: { id: uuid().primaryKey(), title: text().searchable() },
});

const AT = new Date('2026-11-09T10:00:00.000Z');

const plain = entity('sidx_plain', { columns: { id: uuid().primaryKey(), title: text() } });

const codeOf = async (pending: Promise<unknown>): Promise<string> =>
  pending.then(
    () => 'answered',
    (error: unknown) => (isUltimateError(error) ? error.code : `not coded: ${String(error)}`),
  );

describe('searchDocumentOf()', () => {
  test('carries only the searchable columns, the tenant and the row key', () => {
    const row = {
      id: ID.toUpperCase(),
      orgId: ORG,
      title: 'Zebra',
      body: null,
      secretNote: 'x',
      updatedAt: AT,
    };
    expect(searchDocumentOf(posts, row)).toEqual({
      entity: 'sidx_posts',
      tenant: ORG,
      id: ID,
      version: AT.getTime(),
      fields: { title: 'Zebra' },
    });
  });

  test('an untenanted entity is indexed under tenant null', () => {
    expect(searchDocumentOf(shared, { id: ID, title: 'a', updatedAt: AT }).tenant).toBeNull();
  });

  test('the version is the onUpdateNow() instant; an entity with none is refused', () => {
    // A string instant (a raw row) reads as the same version as its Date.
    expect(
      searchDocumentOf(shared, { id: ID, title: 'a', updatedAt: AT.toISOString() as never })
        .version,
    ).toBe(AT.getTime());
    expect(() => searchDocumentOf(unversioned, { id: ID, title: 'a' })).toThrow(
      /declares no onUpdateNow\(\) column/,
    );
    // A projection that dropped the instant cannot be indexed: no version, no document.
    expect(() => searchDocumentOf(shared, { id: ID, title: 'a' } as never)).toThrow(
      /without its updatedAt instant/,
    );
  });
});

describe('searchLimitOf()', () => {
  test('defaults, and refuses a limit no page could hold', () => {
    const query = { entity: 'sidx_posts', tenant: ORG, term: 'a' };
    expect(searchLimitOf(query)).toBe(20);
    for (const limit of [0, -1, 1.5, Number.NaN, 10_001]) {
      expect(() => searchLimitOf({ ...query, limit })).toThrow(/limit must be a whole number/);
    }
  });
});

describe('memorySearchIndex()', () => {
  test('words are letters and digits in any script, case-folded, once each', () => {
    expect(searchWords('Ünïcode, ünïcode! 42 (x)')).toEqual(['ünïcode', '42', 'x']);
  });

  test('ranks the document holding a word more often first', async () => {
    const index = memorySearchIndex();
    await index.index([
      { entity: 'e', tenant: null, id: 'b', version: 1, fields: { title: 'zebra' } },
      { entity: 'e', tenant: null, id: 'a', version: 1, fields: { title: 'zebra zebra' } },
    ]);
    expect(await index.query({ entity: 'e', tenant: null, term: 'zebra' })).toEqual([
      { id: 'a' },
      { id: 'b' },
    ]);
  });

  test('an entity is its own scope', async () => {
    const index = memorySearchIndex();
    await index.index([
      { entity: 'e', tenant: null, id: 'a', version: 1, fields: { title: 'zebra' } },
    ]);
    expect(await index.query({ entity: 'f', tenant: null, term: 'zebra' })).toEqual([]);
  });
});

describe('postgresSearchIndex()', () => {
  test("queries through the repository's own match, tenant predicate included", async () => {
    const client = recordingClient();
    client.on(/websearch_to_tsquery/, {
      rows: [{ id: ID, org_id: ORG, title: 'Zebra', body: null, secret_note: 'x' }],
    });
    const hits = await postgresSearchIndex({ client }).query({
      entity: 'sidx_posts',
      tenant: ORG,
      term: 'zebra',
      limit: 5,
    });
    expect(hits).toEqual([{ id: ID }]);
    const statement = client.statements.find((each) => each.text.includes('websearch_to_tsquery'));
    expect(statement?.text).toContain(`"search_tsv" @@ websearch_to_tsquery('english'`);
    expect(statement?.text).toContain('"org_id"');
    expect(statement?.values).toContain(ORG);
    expect(statement?.values).toContain('zebra');
  });

  test('index and remove send nothing: the server keeps the generated vector', async () => {
    const client = recordingClient();
    const index = postgresSearchIndex({ client });
    await index.index([
      { entity: 'sidx_posts', tenant: ORG, id: ID, version: 1, fields: { title: 'a' } },
    ]);
    await index.remove({ entity: 'sidx_posts', tenant: ORG }, [ID], 1);
    expect(client.statements).toEqual([]);
  });

  test('an entity with no search vector, or none registered, is X_SEARCH_UNDECLARED', async () => {
    const index = postgresSearchIndex({ client: recordingClient() });
    for (const name of [plain.$name, 'sidx_nowhere']) {
      expect(await codeOf(index.query({ entity: name, tenant: null, term: 'a' }))).toBe(
        'X_SEARCH_UNDECLARED',
      );
      expect(
        await codeOf(index.index([{ entity: name, tenant: null, id: ID, version: 1, fields: {} }])),
      ).toBe('X_SEARCH_UNDECLARED');
    }
  });

  test('a tenant named on an untenanted entity is refused, never ignored', async () => {
    const index = postgresSearchIndex({ client: recordingClient() });
    expect(await codeOf(index.query({ entity: shared.$name, tenant: ORG, term: 'a' }))).toBe(
      'X_INVARIANT_VIOLATED',
    );
  });

  test('a tenanted entity searched with no tenant and no actor is X_TENANCY_UNSCOPED', async () => {
    const index = postgresSearchIndex({ client: recordingClient() });
    expect(await codeOf(index.query({ entity: posts.$name, tenant: null, term: 'a' }))).toBe(
      'X_TENANCY_UNSCOPED',
    );
  });
});

describe('installSearchIndex()', () => {
  test('replaces the built-in index until released, and releases only its own frame', () => {
    expect(searchIndex().name).toBe('postgres');
    const first = memorySearchIndex();
    const release = installSearchIndex(first);
    expect(searchIndex()).toBe(first);
    release();
    expect(searchIndex().name).toBe('postgres');
  });
});
