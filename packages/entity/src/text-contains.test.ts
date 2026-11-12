// `contains` on a text column: the statement Postgres is sent (an `ilike` a trigram index serves,
// the operand bound and escaped) and the in-memory answer it must agree with. The answer against a
// real server and the index that serves it are `text-contains.live.test.ts`'s.

import { afterAll, describe, expect, test } from 'bun:test';
import { t } from '@ultimat3/schema';
import { text, uuid } from './columns';
import { json } from './columns-data';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { countStatement } from './pg-sql';
import { clearRegistry } from './registry';
import type { Predicate, QueryPlan } from './tenancy';
import { containsPattern, trigramDeclaration } from './text-contains';

const notes = entity('text_contains_notes', {
  columns: { id: uuid().primaryKey(), title: text(), data: json(t.record(t.string)) },
});

type Row = typeof notes.$row;

afterAll(() => {
  clearRegistry();
});

const planOf = (where: readonly Predicate[]): QueryPlan => ({
  entity: notes.$name,
  where,
  orderBy: [{ column: 'id', direction: 'asc' }],
  limit: 50,
});

const statementOf = (value: unknown) =>
  countStatement(notes, planOf([{ column: 'title', op: 'contains', value }]), {
    includeDeleted: false,
  });

const id = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const ROWS: readonly Row[] = [
  { id: id(1), title: 'Say Hello World', data: {} },
  { id: id(2), title: 'help wanted', data: {} },
  { id: id(3), title: '50% off_today', data: {} },
  { id: id(4), title: '50x offXtoday', data: {} },
];

const titlesFor = async (value: unknown): Promise<readonly string[]> =>
  (
    await memoryRepo(notes, ROWS).findMany({ where: [{ column: 'title', op: 'contains', value }] })
  ).rows.map((row) => row.title);

describe('contains on a text column, compiled', () => {
  test('is a bound ilike — the operator a gin_trgm_ops index serves', () => {
    const statement = statementOf('hello');
    expect(statement.text).toContain('"title" ilike $1');
    expect(statement.text).not.toContain('@>');
    expect(statement.values).toEqual(['%hello%']);
  });

  test('a wildcard in the term is a character to find, never a wildcard', () => {
    expect(statementOf('50%_x\\').values).toEqual(['%50\\%\\_x\\\\%']);
  });

  test('a term that is not text matches no row rather than binding its String()', () => {
    expect(statementOf(5).text).toContain('1 = 0');
    expect(statementOf(null).text).toContain('1 = 0');
  });

  test('a jsonb column keeps structural containment', () => {
    const statement = countStatement(
      notes,
      planOf([{ column: 'data', op: 'contains', value: { a: 'b' } }]),
      { includeDeleted: false },
    );
    expect(statement.text).toContain('"data" @>');
  });
});

describe('contains on a text column, in memory', () => {
  test('is a case-insensitive substring', async () => {
    expect(await titlesFor('HELLO')).toEqual(['Say Hello World']);
    expect(await titlesFor('hel')).toEqual(['Say Hello World', 'help wanted']);
  });

  test('a wildcard in the term is literal, as the escaped pattern is in Postgres', async () => {
    expect(await titlesFor('50%')).toEqual(['50% off_today']);
    expect(await titlesFor('f_t')).toEqual(['50% off_today']);
  });

  test('the empty term matches every row, as %% does', async () => {
    expect(await titlesFor('')).toHaveLength(4);
  });

  test('a term that is not text matches no row', async () => {
    expect(await titlesFor(5)).toEqual([]);
  });
});

describe('containsPattern', () => {
  test('escapes the escape character first, then both wildcards', () => {
    expect(containsPattern('a\\%_b')).toBe('%a\\\\\\%\\_b%');
  });
});

describe('trigramDeclaration', () => {
  test('is the indexes entry that serves the operator, in the db package spelling', () => {
    expect(trigramDeclaration('title')).toBe(
      "indexes: [{ on: ['title'], using: 'gin', operatorClass: 'gin_trgm_ops' }]",
    );
  });
});
