import { afterAll, describe, expect, test } from 'bun:test';
import { text, uuid } from './columns';
import { entity } from './entity';
import { EntityError } from './errors';
import { matchesPredicate } from './memory-match';
import { conditions } from './pg-sql';
import { clearRegistry } from './registry';
import { SEARCH_PROPERTY } from './search';
import type { QueryPlan } from './tenancy';

afterAll(() => {
  clearRegistry();
});

const posts = entity('sql_search_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid(),
    title: text().searchable('A'),
    body: text().nullable().searchable(),
  },
});

const plain = entity('sql_search_plain', {
  columns: { id: uuid().primaryKey(), title: text() },
});

const planFor = (term: string): QueryPlan => ({
  entity: posts.$name,
  where: [
    { column: 'orgId', op: 'eq', value: 'org-1' },
    { column: SEARCH_PROPERTY, op: 'matches', value: term },
  ],
  orderBy: [{ column: 'id', direction: 'asc' }],
  limit: 20,
});

describe('predicateSql · matches', () => {
  test('binds the term and never spells it into the statement', () => {
    const fragment = conditions(posts, planFor('cats & dogs'), { includeDeleted: false });
    expect(fragment.text).toContain('"search_tsv" @@ websearch_to_tsquery(\'english\', $2)');
    expect(fragment.text).not.toContain('cats');
    expect(fragment.values).toEqual(['org-1', 'cats & dogs']);
  });

  test('the tenant predicate is still in the statement beside the match', () => {
    const fragment = conditions(posts, planFor('anything'), { includeDeleted: false });
    expect(fragment.text).toContain('"org_id" = $1');
  });

  test('websearch_to_tsquery is the parser, never bare to_tsquery', () => {
    const fragment = conditions(posts, planFor('a:*'), { includeDeleted: false });
    // A bare `to_tsquery` reads its argument as tsquery SYNTAX, so a `:` or a `&` from a search
    // box is an operator there and a `22P02` at best.
    expect(fragment.text).not.toMatch(/[^_]to_tsquery/);
    expect(fragment.text).not.toContain('plainto_tsquery');
  });

  test('refuses an entity that declares no searchable column', () => {
    const plan: QueryPlan = {
      entity: plain.$name,
      where: [{ column: SEARCH_PROPERTY, op: 'matches', value: 'x' }],
      orderBy: [{ column: 'id', direction: 'asc' }],
      limit: 20,
    };
    expect(() => conditions(plain, plan, { includeDeleted: false })).toThrow(EntityError);
  });
});

describe('memory driver · matches', () => {
  test('refuses rather than answering a different question', () => {
    let thrown: unknown;
    try {
      matchesPredicate(
        posts,
        { title: 'cats' },
        { column: SEARCH_PROPERTY, op: 'matches', value: 'cat' },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EntityError);
    expect((thrown as EntityError).code).toBe('X_SEARCH_IN_MEMORY');
    expect((thrown as EntityError).fix).toContain('live.test.ts');
  });
});
