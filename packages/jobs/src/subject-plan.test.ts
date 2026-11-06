// `planSubject`, pure: the reach a foreign-key walk finds, the children-first order a diamond
// still respects, a new table refused until it has a treatment, and a loop refused unless a
// nullable key in it can be cleared first. Real `entity()` declarations, so the walk reads what
// the registry really hands it.

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { AnyColumn, RegistryEntry } from '@ultimat3/entity';
import { clearRegistry, entity, getEntity, text, uuid } from '@ultimat3/entity';
import type { SubjectTreatment } from './subject';
import { planSubject } from './subject-plan';

afterAll(() => clearRegistry());

const people = entity('sp_people', {
  columns: { id: uuid().primaryKey(), email: text({ max: 80 }) },
});
const posts = entity('sp_posts', {
  columns: {
    id: uuid().primaryKey(),
    authorId: uuid().references(() => people.id, { onDelete: 'restrict' }),
  },
});
// The diamond: a like hangs off the person AND off the person's post.
entity('sp_likes', {
  columns: {
    id: uuid().primaryKey(),
    personId: uuid().references(() => people.id),
    postId: uuid().references(() => posts.id),
  },
});
entity('sp_notes', {
  columns: {
    id: uuid().primaryKey(),
    personId: uuid()
      .nullable()
      .references(() => people.id, { onDelete: 'set null' }),
    body: text({ max: 80 }),
  },
});
entity('sp_copies', {
  columns: { id: uuid().primaryKey(), personRef: uuid(), email: text({ max: 80 }) },
});

const entriesOf = (...names: readonly string[]): readonly RegistryEntry[] =>
  names.map((name) => getEntity(name) as RegistryEntry);

const BASE = ['sp_people', 'sp_posts', 'sp_likes', 'sp_notes'] as const;
const ALL: Readonly<Record<string, SubjectTreatment>> = {
  sp_people: 'delete',
  sp_posts: 'delete',
  sp_likes: 'delete',
  sp_notes: { retain: 'kept for the ledger' },
};

const plan = (
  tables: Readonly<Record<string, SubjectTreatment>>,
  names: readonly string[] = BASE,
  columns?: Readonly<Record<string, string>>,
) => planSubject({ subject: 'sp_people', tables, columns, entries: entriesOf(...names) });

const codes = (result: ReturnType<typeof plan>) =>
  result.problems.map((problem) => (isUltimateError(problem) ? problem.code : 'not-ultimate'));

describe('unit · planSubject', () => {
  test('a diamond is ordered children first: the like before the post, the post before the person', () => {
    const result = plan(ALL);
    expect(result.problems).toEqual([]);
    const order = result.plan.steps.map((step) => step.entity);
    expect(order.at(-1)).toBe('sp_people');
    expect(order).toContain('sp_likes');
    expect(order).toContain('sp_posts');
    expect(order.indexOf('sp_likes')).toBeLessThan(order.indexOf('sp_posts'));
    // Both paths find likes: the person's own, and every like on the person's posts.
    const like = result.plan.steps.find((step) => step.entity === 'sp_likes');
    expect(like?.via.map((v) => `${v.property}->${v.parent}`).sort()).toEqual([
      'personId->sp_people',
      'postId->sp_posts',
    ]);
  });

  test('a new table keyed to the subject is undeclared, named with its path', () => {
    const result = plan({ sp_people: 'delete', sp_likes: 'delete', sp_notes: { retain: 'x' } });
    expect(codes(result)).toEqual(['X_SUBJECT_TABLE_UNDECLARED']);
    expect(result.problems[0]?.cause).toContain('sp_posts');
    expect(result.problems[0]?.cause).toContain('sp_people <- sp_posts.authorId');
  });

  test('the walk goes on only through deleted tables: a retained parent hides its children', () => {
    // Posts kept: the likes ON them are not the person's, so only `personId` finds likes.
    const result = plan({
      ...ALL,
      sp_people: { anonymize: { email: 'gone' } },
      sp_posts: { retain: 'published' },
    });
    expect(result.problems).toEqual([]);
    const like = result.plan.steps.find((step) => step.entity === 'sp_likes');
    expect(like?.via.map((v) => v.parent)).toEqual(['sp_people']);
  });

  test('a kept row under a deleted parent is refused: it would block the delete', () => {
    const result = plan({ ...ALL, sp_posts: { retain: 'published' } });
    expect(codes(result)).toContain('X_SUBJECT_TREATMENT_INVALID');
    expect(result.problems[0]?.cause).toContain('block the delete of sp_people');
  });

  test('a kept row behind a nullable set-null key is fine: the database unlinks it', () => {
    expect(plan(ALL).problems).toEqual([]);
  });

  test('blank retain, unknown column, null on a not-null column: each refused by field', () => {
    for (const treatment of [
      { retain: '  ' },
      { anonymize: { nope: 'x' } },
      { anonymize: { body: null } },
      { anonymize: { id: 'x' } },
      { anonymize: {} },
    ] as const) {
      const result = plan({ ...ALL, sp_notes: treatment });
      expect(codes(result)).toEqual(['X_SUBJECT_TREATMENT_INVALID']);
    }
  });

  test('a treatment for a table nothing reaches is refused, and columns: makes it reached', () => {
    const stray = plan({ ...ALL, sp_copies: 'delete' }, [...BASE, 'sp_copies']);
    expect(codes(stray)).toEqual(['X_SUBJECT_TREATMENT_INVALID']);
    const listed = plan({ ...ALL, sp_copies: 'delete' }, [...BASE, 'sp_copies'], {
      sp_copies: 'personRef',
    });
    expect(listed.problems).toEqual([]);
    const copy = listed.plan.steps.find((step) => step.entity === 'sp_copies');
    expect(copy?.via).toEqual([{ property: 'personRef', parent: 'sp_people', parentKey: 'id' }]);
  });

  test('a loop with no nullable key is refused; with one, it is cleared first', () => {
    const loopA = entity('sp_loop_a', {
      columns: {
        id: uuid().primaryKey(),
        personId: uuid().references(() => people.id),
        bId: uuid().references((): AnyColumn => loopB.id),
      },
    });
    const loopB = entity('sp_loop_b', {
      columns: {
        id: uuid().primaryKey(),
        aId: uuid().references((): AnyColumn => loopA.id),
      },
    });
    const tables = { ...ALL, sp_loop_a: 'delete', sp_loop_b: 'delete' } as const;
    const names = [...BASE, 'sp_loop_a', 'sp_loop_b'];
    expect(codes(plan(tables, names))).toEqual(['X_SUBJECT_CYCLE']);

    const loopC = entity('sp_loop_c', {
      columns: {
        id: uuid().primaryKey(),
        personId: uuid().references(() => people.id),
        parentId: uuid()
          .nullable()
          .references((): AnyColumn => loopC.id),
      },
    });
    const self = plan({ ...ALL, sp_loop_c: 'delete' }, [...BASE, 'sp_loop_c']);
    expect(self.problems).toEqual([]);
    expect(self.plan.unlink).toEqual([
      { entity: 'sp_loop_c', property: 'parentId', parent: 'sp_loop_c', parentKey: 'id' },
    ]);
  });

  test("'delete' on an append-only entity is refused", () => {
    entity('sp_events', {
      appendOnly: true,
      columns: { id: uuid().primaryKey(), personId: uuid().references(() => people.id) },
    });
    const result = plan({ ...ALL, sp_events: 'delete' }, [...BASE, 'sp_events']);
    expect(codes(result)).toEqual(['X_SUBJECT_TREATMENT_INVALID']);
    expect(result.problems[0]?.cause).toContain('append-only');
  });
});
