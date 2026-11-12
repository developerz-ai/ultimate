// A text `contains` (`ilike`, `~~*` in a plan) is served by a `gin_trgm_ops` index and by nothing
// else: the finding names that declaration, a btree on the column does not argue it away, and a
// declared trigram index does.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import type { PlanVerdict } from './plan-oracle';
import { planFindings } from './plan-sweep-fix';
import type { SeedEntity } from './seed-graph-shape';

afterAll(() => clearRegistry());

const psfNotes = entity('psf_notes', {
  columns: { id: uuid().primaryKey(), title: text(), body: text() },
  indexes: [{ on: ['title'] }, { on: ['body'], using: 'gin', operatorClass: 'gin_trgm_ops' }],
});
const byTable = new Map<string, SeedEntity>([['psf_notes', psfNotes]]);

const scanOf = (column: string): PlanVerdict => ({
  code: 'X_QUERY_UNINDEXED',
  node: 'Seq Scan',
  table: 'psf_notes',
  equality: [],
  range: [column],
  order: [],
});

const TRIGRAM = "indexes: [{ on: ['title'], using: 'gin', operatorClass: 'gin_trgm_ops' }]";

describe('unit · planFindings · trigram', () => {
  test('an ilike a btree cannot serve names the trigram declaration, never "declared"', () => {
    const [finding] = planFindings(
      'select count(*) as count from "psf_notes" where "title" ilike $1',
      [scanOf('title')],
      byTable,
    );
    expect(finding?.unserved).toBeUndefined();
    expect(finding?.index).toEqual(['title']);
    expect(finding?.declaration).toBe(TRIGRAM);
  });

  test('the plan spelling ~~* is the same operator', () => {
    const [finding] = planFindings(
      'select * from psf_notes where (title ~~* $1)',
      [scanOf('title')],
      byTable,
    );
    expect(finding?.declaration).toBe(TRIGRAM);
  });

  test('a declared gin_trgm_ops index on the column serves it', () => {
    expect(
      planFindings(
        'select count(*) as count from "psf_notes" where "body" ilike $1',
        [scanOf('body')],
        byTable,
      ),
    ).toEqual([]);
  });

  test('a plain like keeps the btree rule: the declared index is the answer', () => {
    const [finding] = planFindings(
      'select count(*) as count from "psf_notes" where "title" like $1',
      [scanOf('title')],
      byTable,
    );
    expect(finding?.unserved).toBe('declared');
    expect(finding?.declaration).toBeUndefined();
  });
});
