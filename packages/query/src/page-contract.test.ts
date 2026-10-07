// The one page shape, as a CONTRACT between its two producers: `@ultimat3/entity`'s `findMany` and
// this package's `.page()` answer the same rows as the same pages, and each says "last page" the
// same way — `hasMore: false` AND `nextCursor: null`. Before 25.0.0 the read kept a cursor on its
// last page, so a `while (page.nextCursor)` loop fetched an empty page past the end of it.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Page } from '@ultimat3/core';
import { configureCursorSigning, ctxOf, userActor } from '@ultimat3/core';
import { clearRegistry, entity, memoryRepo, text, uuid } from '@ultimat3/entity';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { paginate } from './pagination';
import { query } from './query';
import { registerQuery, resetQueries } from './registry';
import { from } from './source';

const ORG = '00000000-0000-4000-8000-000000000001';
const ctx = ctxOf({ actor: { ...userActor({ id: 'u1' }), permissions: ['notes:read'] } });
const PAGE = 2;

const notes = entity('page_contract_notes', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), title: text() },
});
type Note = typeof notes.$row;

const seed = (count: number): readonly Note[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-7000-8000-00000000010${index}`,
    orgId: ORG,
    title: String.fromCharCode(97 + index),
  }));

/** One page's verdict: the rows it served and how it said whether another follows. */
const verdict = (page: Page<Note>) => ({
  titles: page.rows.map((row) => row.title).join(''),
  hasMore: page.hasMore,
  nextCursor: page.nextCursor === null ? null : 'cursor',
});

/** The consumer loop every caller writes: one fetch per page, stopping on `hasMore`. */
const walk = async (read: (cursor: string | null) => Promise<Page<Note>>) => {
  const pages: Page<Note>[] = [];
  let page = await read(null);
  pages.push(page);
  while (page.hasMore) {
    page = await read(page.nextCursor);
    pages.push(page);
  }
  return pages.map(verdict);
};

const viaRepo = (rows: readonly Note[]) => {
  const repo = memoryRepo(notes, rows);
  return walk((cursor) =>
    repo.findMany({
      orgId: ORG,
      limit: PAGE,
      cursor,
      orderBy: [{ column: 'title', direction: 'asc' }],
    }),
  );
};

const viaQuery = (rows: readonly Note[]) => {
  const read = registerQuery(
    'pageContractNotes',
    query({
      input: t.object({ orgId: t.uuid }),
      policy: can('notes:read'),
      sql: ({ orgId }) => from<Note>('page_contract_notes', rows).where({ orgId }).orderBy('title'),
    }),
  );
  return walk((cursor) =>
    paginate(
      read,
      { orgId: ORG },
      { first: PAGE, ctx, ...(cursor === null ? {} : { after: cursor }) },
    ),
  );
};

describe('a repo page and a query page are one page', () => {
  beforeEach(() => {
    resetQueries();
    configureCursorSigning('page-contract-secret');
  });
  afterAll(() => {
    clearRegistry();
  });

  test('a middle page carries both facts; the last page carries neither', async () => {
    const expected = [
      { titles: 'ab', hasMore: true, nextCursor: 'cursor' },
      { titles: 'cd', hasMore: true, nextCursor: 'cursor' },
      { titles: 'e', hasMore: false, nextCursor: null },
    ];
    expect(await viaRepo(seed(5))).toEqual(expected);
    expect(await viaQuery(seed(5))).toEqual(expected);
  });

  test('a listing that ends ON a page boundary stops there — no empty page fetched past it', async () => {
    const expected = [
      { titles: 'ab', hasMore: true, nextCursor: 'cursor' },
      { titles: 'cd', hasMore: false, nextCursor: null },
    ];
    expect(await viaRepo(seed(4))).toEqual(expected);
    expect(await viaQuery(seed(4))).toEqual(expected);
  });

  test('an empty listing is one last page', async () => {
    const expected = [{ titles: '', hasMore: false, nextCursor: null }];
    expect(await viaRepo([])).toEqual(expected);
    expect(await viaQuery([])).toEqual(expected);
  });
});
