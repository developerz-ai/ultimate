// The static half of the subject proof: a table keyed to the declared subject with no treatment is
// `X_SUBJECT_TABLE_UNDECLARED`, at the subject, naming the table — and a complete declaration is
// clean. Real `entity()` declarations, so the plan reads what the registry hands it.

import { afterAll, describe, expect, test } from 'bun:test';
import type { RegistryEntry } from '@ultimat3/entity';
import { clearRegistry, entity, getEntity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { defineSubject, resetSubjects } from '@ultimat3/jobs';
import { subjectFindings } from './exercise-subject';

afterAll(() => {
  clearRegistry();
  resetSubjects();
});

const people = entity('xsub_people', {
  columns: { id: uuid().primaryKey(), email: text({ max: 80 }) },
});
entity('xsub_likes', {
  columns: { id: uuid().primaryKey(), personId: uuid().references(() => people.id) },
});
entity('xsub_orders', {
  columns: { id: uuid().primaryKey(), personId: uuid().references(() => people.id) },
});

const entries = (...names: string[]) => names.map((name) => getEntity(name) as RegistryEntry);

describe('unit · subjectFindings', () => {
  test('a reached table with no treatment is a finding naming it', () => {
    const subject = defineSubject(people, {
      driver: memoryDriver(),
      key: (input: { id: string }) => input.id,
      tables: { xsub_people: 'delete', xsub_likes: 'delete' },
    });
    const findings = subjectFindings(
      [subject as never],
      entries('xsub_people', 'xsub_likes', 'xsub_orders'),
    );
    expect(findings.map((f) => [f.code, f.at])).toEqual([
      ['X_SUBJECT_TABLE_UNDECLARED', 'xsub_people'],
    ]);
    expect(findings[0]?.cause).toContain('xsub_orders');
    expect(findings[0]?.fix).toContain("tables: { xsub_orders: 'delete' }");
  });

  test('every reached table treated is clean; no subject is no check', () => {
    const subject = defineSubject(people, {
      driver: memoryDriver(),
      key: (input: { id: string }) => input.id,
      tables: {
        xsub_people: { anonymize: { email: 'erased@invalid' } },
        xsub_likes: 'delete',
        xsub_orders: { retain: 'tax law' },
      },
    });
    const all = entries('xsub_people', 'xsub_likes', 'xsub_orders');
    expect(subjectFindings([subject as never], all)).toEqual([]);
    expect(subjectFindings([], all)).toEqual([]);
  });
});
