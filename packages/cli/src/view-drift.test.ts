// `X_ENTITY_VIEW_DRIFT`: a view entity's declared `columns` held against the output columns of
// the view the migrations created, as the scratch replay's catalog reads them. A column declared
// and never output fails every read (`42703`); one output and never declared is unreachable.

import { describe, expect, test } from 'bun:test';
import type { EntityDescriptionLike } from '@ultimat3/db';
import { type CatalogDescription, emptyCatalog } from '@ultimat3/db/schema-dump';
import { viewColumnFindings } from './view-drift';

const column = (name: string) => ({
  property: name,
  column: name,
  kind: 'integer',
  notNull: true,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
});

const totals = (...columns: readonly string[]): EntityDescriptionLike => ({
  name: 'postLikeTotals',
  table: 'post_like_totals',
  primaryKey: ['post_id'],
  columns: columns.map(column),
  indexes: [],
  view: { sql: 'select post_id, count(*)::integer as likes from likes group by post_id' },
});

const catalogWith = (columns?: readonly string[]): CatalogDescription => ({
  ...emptyCatalog(),
  views: [
    {
      name: 'post_like_totals',
      materialized: false,
      options: null,
      definition: 'SELECT 1;',
      ...(columns === undefined ? {} : { columns }),
    },
  ],
});

describe('unit · view columns against the created view', () => {
  test('the same names, in any order, agree', () => {
    expect(
      viewColumnFindings([totals('likes', 'post_id')], catalogWith(['post_id', 'likes'])),
    ).toEqual([]);
  });

  test('a declared column the view never outputs is one finding naming both lists', () => {
    const [finding, ...rest] = viewColumnFindings(
      [totals('post_id', 'likes', 'org_id')],
      catalogWith(['post_id', 'likes']),
    );
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_ENTITY_VIEW_DRIFT');
    expect(finding?.cause).toBe(
      'view entity postLikeTotals declares "org_id", which view "post_like_totals" does not output — its columns are post_id, likes',
    );
    expect(finding?.fix).toStartWith('x entities show postLikeTotals --json');
  });

  test('an output column no entity column names is a finding too', () => {
    const [finding] = viewColumnFindings([totals('post_id')], catalogWith(['post_id', 'likes']));
    expect(finding?.cause).toContain(
      'outputs "likes", which no column of view entity postLikeTotals names',
    );
  });

  test('a view not yet created, a table, and a hand-built catalog are left to their own rails', () => {
    const table: EntityDescriptionLike = { ...totals('post_id'), view: undefined };
    expect(viewColumnFindings([totals('post_id')], emptyCatalog())).toEqual([]);
    expect(viewColumnFindings([table], catalogWith(['likes']))).toEqual([]);
    expect(viewColumnFindings([totals('post_id')], catalogWith())).toEqual([]);
  });
});
