// `planSubject` and a `history` table: its `row_id` is no foreign key, so the walk alone never finds
// it — yet an erase that rewrites the parent leaves the person's data in its before/after images.
// Reached exactly when its parent is written (deleted or anonymized); `'delete'` and `{ retain }`
// are its treatments, never `anonymize` (history is never rewritten).

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { RegistryEntry } from '@ultimat3/entity';
import { clearRegistry, entity, getEntity, text, uuid } from '@ultimat3/entity';
import type { SubjectTreatment } from './subject';
import { planSubject } from './subject-plan';

afterAll(() => clearRegistry());

const people = entity('sph_people', {
  columns: { id: uuid().primaryKey(), email: text({ max: 80 }) },
});
entity('sph_posts', {
  history: true,
  columns: {
    id: uuid().primaryKey(),
    authorId: uuid().references(() => people.id, { onDelete: 'restrict' }),
    title: text({ max: 80 }),
  },
});

const NAMES = ['sph_people', 'sph_posts', 'sph_posts_history'] as const;
const plan = (tables: Readonly<Record<string, SubjectTreatment>>) =>
  planSubject({
    subject: 'sph_people',
    tables,
    entries: NAMES.map((name) => getEntity(name) as RegistryEntry),
  });
const codes = (result: ReturnType<typeof plan>) =>
  result.problems.map((problem) => (isUltimateError(problem) ? problem.code : 'not-ultimate'));

describe('unit · planSubject · history tables', () => {
  test('a deleted parent reaches its history: undeclared, it is named with its path', () => {
    const result = plan({ sph_people: 'delete', sph_posts: 'delete' });
    expect(codes(result)).toEqual(['X_SUBJECT_TABLE_UNDECLARED']);
    expect(result.problems[0]?.cause).toContain('sph_posts_history');
    expect(result.problems[0]?.cause).toContain('sph_posts <- sph_posts_history.rowId');
  });

  test('an anonymized parent reaches it too: anonymizing writes a before image', () => {
    const result = plan({ sph_people: 'delete', sph_posts: { anonymize: { title: '' } } });
    expect(codes(result)).toContain('X_SUBJECT_TABLE_UNDECLARED');
  });

  test("'delete' rides the parent's own step: removed in its transaction, after its write", () => {
    const result = plan({
      sph_people: 'delete',
      sph_posts: 'delete',
      sph_posts_history: 'delete',
    });
    expect(result.problems).toEqual([]);
    expect(result.plan.steps.map((step) => step.entity)).toEqual(['sph_posts', 'sph_people']);
    const posts = result.plan.steps.find((step) => step.entity === 'sph_posts');
    expect(posts?.history).toBe('sph_posts_history');
  });

  test('{ retain } is a step of its own, before the parent, found by row id', () => {
    const result = plan({
      sph_people: 'delete',
      sph_posts: 'delete',
      sph_posts_history: { retain: 'the audit trail outlives the post' },
    });
    expect(result.problems).toEqual([]);
    expect(result.plan.steps.map((step) => step.entity)).toEqual([
      'sph_posts_history',
      'sph_posts',
      'sph_people',
    ]);
    expect(result.plan.steps[0]?.via).toEqual([
      { property: 'rowId', parent: 'sph_posts', parentKey: 'id' },
    ]);
    expect(result.plan.steps[1]?.history).toBeUndefined();
  });

  test('anonymize on a history table is refused: its rows are never rewritten', () => {
    const result = plan({
      sph_people: 'delete',
      sph_posts: 'delete',
      sph_posts_history: { anonymize: { actorId: null } },
    });
    expect(codes(result)).toEqual(['X_SUBJECT_TREATMENT_INVALID']);
    expect(result.problems[0]?.cause).toContain('never rewritten');
  });

  test('a retained parent writes nothing, so its history is unreached and a declaration of it stray', () => {
    const keep = { sph_people: { anonymize: { email: 'gone' } }, sph_posts: { retain: 'kept' } };
    expect(plan(keep).problems).toEqual([]);
    expect(codes(plan({ ...keep, sph_posts_history: 'delete' }))).toEqual([
      'X_SUBJECT_TREATMENT_INVALID',
    ]);
  });
});
