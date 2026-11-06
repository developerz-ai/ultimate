// The views half of the declared-vs-recorded comparison: a view the entities declare and no
// migration created is found, as is one a migration created and nothing declares any more, and a
// query or `materialized` that moved since the migration was written.

import { describe, expect, test } from 'bun:test';
import type { SchemaDescription, ViewDescription } from '@ultimat3/db';
import { diffDeclaredSchema } from './schema-diff';
import { schemaDifferenceCause } from './schema-drift';

const TOTALS: ViewDescription = {
  name: 'post_like_totals',
  materialized: true,
  create: [
    'create materialized view "post_like_totals" as select post_id, count(*) as likes from likes group by post_id;',
    'create unique index "post_like_totals_post_id_key" on "post_like_totals" ("post_id");',
  ],
};

const withViews = (...views: readonly ViewDescription[]): SchemaDescription =>
  views.length === 0 ? { tables: [] } : { tables: [], views };

describe('unit · declared views vs recorded snapshot', () => {
  test('a view declared and never generated is one unmigrated view difference', () => {
    const [found, ...rest] = diffDeclaredSchema(withViews(TOTALS), withViews());
    expect(rest).toEqual([]);
    expect(found).toMatchObject({
      direction: 'unmigrated',
      part: 'view',
      table: 'post_like_totals',
      name: 'post_like_totals',
    });
    if (found === undefined) return expect.unreachable('the view is a difference');
    expect(schemaDifferenceCause(found)).toBe(
      'view "post_like_totals" is declared by the entities and no migration recorded it',
    );
  });

  test('a recorded view no entity declares is undeclared', () => {
    expect(diffDeclaredSchema(withViews(), withViews(TOTALS))).toEqual([
      expect.objectContaining({ direction: 'undeclared', part: 'view', name: 'post_like_totals' }),
    ]);
  });

  test('a changed query is unmigrated, naming what moved', () => {
    const [moved] = TOTALS.create;
    const edited = { ...TOTALS, create: [`${moved?.slice(0, -1)} having count(*) > 1;`] };
    expect(diffDeclaredSchema(withViews(edited), withViews(TOTALS))).toEqual([
      expect.objectContaining({
        direction: 'unmigrated',
        part: 'view',
        detail: 'is declared with a query or index the newest migration did not record',
      }),
    ]);
  });

  test('materialized flipping is its own detail', () => {
    const plain: ViewDescription = { name: TOTALS.name, create: TOTALS.create };
    expect(diffDeclaredSchema(withViews(plain), withViews(TOTALS))).toEqual([
      expect.objectContaining({
        detail: 'is declared a plain view and was recorded materialized',
      }),
    ]);
  });

  test('the same views on both sides, and a snapshot from before views existed, agree', () => {
    expect(diffDeclaredSchema(withViews(TOTALS), withViews(TOTALS))).toEqual([]);
    expect(diffDeclaredSchema({ tables: [] }, { tables: [], views: [] })).toEqual([]);
  });
});
