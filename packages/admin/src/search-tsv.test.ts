// The full-text half of the admin search: an entity that declares a search vector is asked through
// it FIRST, and the per-field `contains` loop fills a short page — so a whole-word hit and a
// substring ("ali" → "Alice") both answer. The memory driver cannot search a vector, so there the
// `contains` loop is the whole answer; a custom repo with no `search` is searched as before.

import { afterAll, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { clearRegistry, database, entity, memoryDriver, newId, text, uuid } from '@ultimat3/entity';
import { memoryAuditLog } from './audit';
import { type AdminActor, staticAuthz } from './authz';
import type { CrudCtx } from './crud';
import type { AdminListQuery, AdminRepo, AdminRow, AdminSearchQuery } from './registry';
import { adminRepoFor } from './repo-entity';
import { adminResource } from './resource';
import { adminSearch } from './search';

const people = entity('admin_tsv_people', {
  columns: {
    id: uuid().primaryKey(),
    name: text({ max: 80 }).searchable('A'),
    bio: text().searchable(),
  },
});

afterAll(clearRegistry);

const actor: AdminActor = { id: 'u_tsv' };
const ctx = (): CrudCtx => ({
  actor,
  authz: staticAuthz(['admin:read', 'admin_tsv_people:read']),
  audit: memoryAuditLog(),
  requestId: 'req_tsv',
});

const person = (name: string): AdminRow => ({ id: newId(), name, bio: '' });

interface Calls {
  readonly searched: AdminSearchQuery[];
  readonly listed: AdminListQuery[];
}

/** A repo whose `search` answers `bySearch` and whose `list` answers `byList`, recording both. */
const recording = (
  bySearch: readonly AdminRow[] | (() => Promise<readonly AdminRow[]>),
  byList: readonly AdminRow[],
  calls: Calls,
): AdminRepo<AdminRow> => ({
  list: async (query) => {
    calls.listed.push(query);
    return byList;
  },
  search: async (query) => {
    calls.searched.push(query);
    return typeof bySearch === 'function' ? bySearch() : bySearch;
  },
  find: async () => null,
  create: async (input) => input,
  update: async (_id, patch) => patch,
  destroy: async () => undefined,
});

const run = (repo: AdminRepo<AdminRow>, term: string, limitPerResource?: number) =>
  adminSearch({
    term,
    resources: [adminResource(people, { repo })],
    ctx: ctx(),
    ...(limitPerResource === undefined ? {} : { limitPerResource }),
  });

describe('adminSearch over an entity that declares a search vector', () => {
  test('the vector is asked first; the contains loop fills the short page, deduplicated', async () => {
    const alice = person('Alice');
    const alina = person('Alina');
    const calls: Calls = { searched: [], listed: [] };
    const found = await run(recording([alice], [alice, alina], calls), 'ali');

    expect(found.hits.map((hit) => [hit.label, hit.matchedField])).toEqual([
      ['Alice', 'search_tsv'],
      ['Alina', 'name'],
    ]);
    expect(calls.searched).toHaveLength(1);
    expect(calls.searched[0]?.term).toBe('ali');
    expect(calls.searched[0]?.sort).toEqual({ field: 'id', direction: 'desc' });
    // Two searchable text fields: 1 + 2 statements, never more.
    expect(calls.listed).toHaveLength(2);
  });

  test('a full page from the vector reads no contains statement at all', async () => {
    const calls: Calls = { searched: [], listed: [] };
    const found = await run(recording([person('A'), person('B')], [], calls), 'x', 2);

    expect(found.hits).toHaveLength(2);
    expect(calls.listed).toHaveLength(0);
  });

  test('the row scope rides the vector read as it rides every contains', async () => {
    const calls: Calls = { searched: [], listed: [] };
    const scoped = adminResource(people, {
      repo: recording([], [], calls),
      rows: () => [{ field: 'name', op: 'contains', value: 'Acme' }],
    });
    await adminSearch({ term: 'acme', resources: [scoped], ctx: ctx() });

    expect(calls.searched[0]?.where).toEqual([
      { field: 'name', op: 'contains', value: 'Acme', caseSensitive: true },
    ]);
  });

  test('X_SEARCH_IN_MEMORY falls back to the contains loop: the memory driver still answers', async () => {
    const table = database({ people }, { driver: memoryDriver() }).people;
    const repo = adminRepoFor(people, table);
    await repo.create({ name: 'Alice', bio: '' });
    const found = await run(repo, 'ali');

    expect(found.skipped).toEqual([]);
    expect(found.hits.map((hit) => [hit.label, hit.matchedField])).toEqual([['Alice', 'name']]);
  });

  test('any other failure of the vector read is the resource skipped as failed', async () => {
    const calls: Calls = { searched: [], listed: [] };
    const broken = recording(
      async () => {
        // A foreign failure handed to the code under test is input, not a verdict.
        throw new UltimateError({ code: 'X_ADMIN_INVALID', cause: 'index down', fix: 'x doctor' });
      },
      [person('Alice')],
      calls,
    );
    const found = await run(broken, 'ali');

    expect(found.skipped).toEqual([
      { entity: 'admin_tsv_people', reason: 'admin.search.skipped.failed' },
    ]);
    expect(calls.listed).toHaveLength(0);
  });

  test('a custom repo with no search is searched by contains alone, as before', async () => {
    const calls: Calls = { searched: [], listed: [] };
    const { search: _dropped, ...plain } = recording([], [person('Alice')], calls);
    const found = await run(plain, 'ali');

    expect(found.hits.map((hit) => hit.matchedField)).toEqual(['name']);
    expect(calls.searched).toHaveLength(0);
    expect(calls.listed).toHaveLength(2);
  });
});
