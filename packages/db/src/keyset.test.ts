// `keyset()` as text and as a page: the fragments it splices, the cursor it mints and refuses, and
// the null key it will not page past. Which rows a real server answers is `keyset.live.test.ts`
// and `keyset-embedded.test.ts`.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import type { KeysetKey } from './keyset';
import { keyset } from './keyset';
import { raw, sql } from './sql';

const at = (direction: 'asc' | 'desc'): KeysetKey => ({
  column: raw('p.created_at'),
  kind: 'timestamptz',
  direction,
});
const id = (direction: 'asc' | 'desc'): KeysetKey => ({
  column: raw('p.id'),
  kind: 'uuid',
  direction,
});

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof UltimateError) return error.code;
    return expect.unreachable(`threw something that is not an UltimateError: ${String(error)}`);
  }
  return expect.unreachable('did not throw');
};

/** A page's rows as the server answers them: the keys as text, under keyset()'s aliases. */
const row = (title: string, createdAt: string, rowId: string) => ({
  title,
  _keyset_0: createdAt,
  _keyset_1: rowId,
});

const firstPage = (keys: readonly KeysetKey[], limit = 2) =>
  keyset({ scope: 'feed', keys, after: null, limit }).page([
    row('a', '2026-01-01 00:00:00.123900+00', '00000000-0000-7000-8000-000000000003'),
    row('b', '2026-01-01 00:00:00.123500+00', '00000000-0000-7000-8000-000000000001'),
    row('c', '2026-01-01 00:00:00.123100+00', '00000000-0000-7000-8000-000000000002'),
  ]);

describe('keyset() fragments', () => {
  test('selects every key as text, under an alias page() strips', () => {
    const page = keyset({ scope: 'feed', keys: [at('desc'), id('desc')], after: null, limit: 2 });
    expect(page.select.text).toBe('p.created_at::text as "_keyset_0", p.id::text as "_keyset_1"');
    expect(page.orderBy.text).toBe('p.created_at desc, p.id desc');
    expect(page.limit.values).toEqual([3]);
  });

  test('the first page seeks nothing', () => {
    const page = keyset({ scope: 'feed', keys: [at('desc'), id('desc')], after: null, limit: 2 });
    expect(page.where.text).toBe('true');
    expect(page.where.values).toEqual([]);
  });

  test('a uniform order is one row comparison, each bind cast by its kind', () => {
    const cursor = firstPage([at('desc'), id('desc')]).nextCursor ?? '';
    const desc = keyset({ scope: 'feed', keys: [at('desc'), id('desc')], after: cursor, limit: 2 });
    expect(desc.where.text).toBe('(p.created_at, p.id) < ($1::timestamptz, $2::uuid)');
    // The text the server answered, bound back verbatim: no `Date`, so no microsecond is lost.
    expect(desc.where.values).toEqual([
      '2026-01-01 00:00:00.123500+00',
      '00000000-0000-7000-8000-000000000001',
    ]);
    const ascCursor = firstPage([at('asc'), id('asc')]).nextCursor ?? '';
    const asc = keyset({ scope: 'feed', keys: [at('asc'), id('asc')], after: ascCursor, limit: 2 });
    expect(asc.where.text).toBe('(p.created_at, p.id) > ($1::timestamptz, $2::uuid)');
  });

  test('one key is a scalar comparison', () => {
    const keys = [at('asc')];
    const cursor = keyset({ scope: 'feed', keys, after: null, limit: 1 }).page([
      { _keyset_0: '2026-01-01 00:00:00.1+00' },
      { _keyset_0: '2026-01-01 00:00:00.2+00' },
    ]).nextCursor;
    const next = keyset({ scope: 'feed', keys, after: cursor, limit: 1 });
    expect(next.where.text).toBe('p.created_at > $1::timestamptz');
  });

  test('a mixed order is the or-chain, each term in its own direction', () => {
    const keys = [at('desc'), id('asc')];
    const cursor = firstPage(keys).nextCursor ?? '';
    const page = keyset({ scope: 'feed', keys, after: cursor, limit: 2 });
    expect(page.where.text).toBe(
      '(p.created_at < $1::timestamptz or (p.created_at = $2::timestamptz and p.id > $3::uuid))',
    );
    expect(page.orderBy.text).toBe('p.created_at desc, p.id asc');
  });

  test('every kind casts as itself', () => {
    const keys: KeysetKey[] = [
      { column: raw('a'), kind: 'text', direction: 'asc' },
      { column: raw('b'), kind: 'integer', direction: 'asc' },
      { column: raw('c'), kind: 'bigint', direction: 'asc' },
    ];
    const cursor = keyset({ scope: 's', keys, after: null, limit: 1 }).page([
      { _keyset_0: 'x', _keyset_1: '1', _keyset_2: '9007199254740993' },
      { _keyset_0: 'y', _keyset_1: '2', _keyset_2: '9007199254740994' },
    ]).nextCursor;
    const page = keyset({ scope: 's', keys, after: cursor, limit: 1 });
    expect(page.where.text).toBe('(a, b, c) > ($1::text, $2::integer, $3::bigint)');
    expect(page.where.values).toEqual(['x', '1', '9007199254740993']);
  });

  test('a key column carrying its own bind renumbers inside the statement', () => {
    const keys: KeysetKey[] = [
      {
        column: sql`coalesce(p.published_at, ${'2026-01-01'}::timestamptz)`,
        kind: 'timestamptz',
        direction: 'desc',
      },
    ];
    const page = keyset({ scope: 's', keys, after: null, limit: 5 });
    const statement = sql`select ${page.select} from p where ${page.where} order by ${page.orderBy} limit ${page.limit}`;
    expect(statement.text).toBe(
      'select coalesce(p.published_at, $1::timestamptz)::text as "_keyset_0" from p where true order by coalesce(p.published_at, $2::timestamptz) desc limit $3',
    );
  });
});

describe('keyset() pages', () => {
  test('reads one past the limit, keeps the limit, strips the aliases', () => {
    const page = firstPage([at('desc'), id('desc')]);
    expect(page.rows).toEqual([{ title: 'a' }, { title: 'b' }]);
    expect(page.hasMore).toBe(true);
  });

  test('the last page carries no cursor', () => {
    const page = firstPage([at('desc'), id('desc')], 3);
    expect(page.rows).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  test("another scope's cursor is refused", () => {
    const cursor = firstPage([at('desc'), id('desc')]).nextCursor ?? '';
    const other = () =>
      keyset({ scope: 'inbox', keys: [at('desc'), id('desc')], after: cursor, limit: 2 });
    expect(codeOf(other)).toBe('X_CURSOR_INVALID');
  });

  test('the same scope under another sort is refused', () => {
    const cursor = firstPage([at('desc'), id('desc')]).nextCursor ?? '';
    const flipped = () =>
      keyset({ scope: 'feed', keys: [at('asc'), id('asc')], after: cursor, limit: 2 });
    expect(codeOf(flipped)).toBe('X_CURSOR_INVALID');
    const retyped = () =>
      keyset({
        scope: 'feed',
        keys: [at('desc'), { ...id('desc'), kind: 'text' }],
        after: cursor,
        limit: 2,
      });
    expect(codeOf(retyped)).toBe('X_CURSOR_INVALID');
  });

  test('a tampered cursor is refused', () => {
    const cursor = firstPage([at('desc'), id('desc')]).nextCursor ?? '';
    const tampered = `x${cursor}`;
    const run = () =>
      keyset({ scope: 'feed', keys: [at('desc'), id('desc')], after: tampered, limit: 2 });
    expect(codeOf(run)).toBe('X_CURSOR_INVALID');
  });

  test('a null key on any row is refused, not only on the row the cursor is cut from', () => {
    const keys = [at('desc'), id('desc')];
    const rows = [
      row('a', '2026-01-01 00:00:00+00', 'u1'),
      { title: 'b', _keyset_0: null, _keyset_1: 'u2' },
    ];
    const run = () => keyset({ scope: 'feed', keys, after: null, limit: 5 }).page(rows);
    expect(codeOf(run)).toBe('X_KEYSET_NULL_KEY');
  });

  test('a row without the selected keys names the missing splice', () => {
    const run = () =>
      keyset({ scope: 'feed', keys: [at('desc')], after: null, limit: 5 }).page([{ title: 'a' }]);
    expect(codeOf(run)).toBe('X_INVARIANT');
  });
});

describe('keyset() arguments', () => {
  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('limit %p is refused', (limit) => {
    expect(codeOf(() => keyset({ scope: 'feed', keys: [at('desc')], after: null, limit }))).toBe(
      'X_INVARIANT',
    );
  });

  test('no keys and an empty scope are refused', () => {
    expect(codeOf(() => keyset({ scope: 'feed', keys: [], after: null, limit: 1 }))).toBe(
      'X_INVARIANT',
    );
    expect(codeOf(() => keyset({ scope: '', keys: [at('desc')], after: null, limit: 1 }))).toBe(
      'X_INVARIANT',
    );
  });
});
