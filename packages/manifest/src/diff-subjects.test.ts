// A subject removed, or a table moving from kept to `delete`, is breaking: an erase that destroys
// rows the last release kept cannot be taken back. Adding either is additive; the rest internal.
// And the section is written only when an app declares a subject, sorted whatever the order.

import { describe, expect, test } from 'bun:test';
import { buildManifest } from './build';
import type { ChangeKind, ManifestChange } from './diff-change';
import { diffSubjects } from './diff-subjects';
import type { SubjectFact } from './schema-subjects';

const MEMBER: SubjectFact = {
  entity: 'member',
  batch: 200,
  tables: [
    { entity: 'comment', treatment: 'anonymize', columns: ['authorName'] },
    { entity: 'invoice', treatment: 'retain', reason: 'tax law: 10 years' },
    { entity: 'member', treatment: 'delete' },
  ],
  targets: [{ name: 'files', retained: false }],
};

const only = (changes: readonly ManifestChange[]): readonly [ChangeKind, string][] =>
  changes.map((change) => [change.kind, change.path]);

const withTable = (entity: string, treatment: SubjectFact['tables'][number]): SubjectFact => ({
  ...MEMBER,
  tables: MEMBER.tables.map((table) => (table.entity === entity ? treatment : table)),
});

describe('unit · diffSubjects', () => {
  test('nothing moved, nothing reported', () => {
    expect(diffSubjects([MEMBER], [MEMBER])).toEqual([]);
  });

  test('a subject removed is breaking, one added is additive', () => {
    expect(only(diffSubjects([MEMBER], []))).toEqual([['breaking', 'subjects.member']]);
    expect(only(diffSubjects([], [MEMBER]))).toEqual([['additive', 'subjects.member']]);
  });

  test('retain or anonymize becoming delete is breaking', () => {
    expect(
      only(
        diffSubjects([MEMBER], [withTable('invoice', { entity: 'invoice', treatment: 'delete' })]),
      ),
    ).toEqual([['breaking', 'subjects.member.tables.invoice.treatment']]);
    expect(
      only(
        diffSubjects([MEMBER], [withTable('comment', { entity: 'comment', treatment: 'delete' })]),
      ),
    ).toEqual([['breaking', 'subjects.member.tables.comment.treatment']]);
  });

  test('delete becoming retain is internal; a table added is additive', () => {
    const kept = withTable('member', { entity: 'member', treatment: 'retain', reason: 'audit' });
    expect(only(diffSubjects([MEMBER], [kept]))).toEqual([
      ['internal', 'subjects.member.tables.member.treatment'],
    ]);
    const more = {
      ...MEMBER,
      tables: [...MEMBER.tables, { entity: 'like', treatment: 'delete' as const }],
    };
    expect(only(diffSubjects([MEMBER], [more]))).toEqual([
      ['additive', 'subjects.member.tables.like'],
    ]);
  });
});

describe('unit · the subjects section', () => {
  const app = { name: 'acme', version: '1.0.0' };

  test('no subject writes no key, so an app without one keeps its bytes and its buildId', () => {
    const none = buildManifest({ app });
    expect('subjects' in none).toBe(false);
    expect(buildManifest({ app, subjects: [] }).buildId).toBe(none.buildId);
  });

  test('declaration order is never a diff: subjects, tables, targets and columns are sorted', () => {
    const shuffled: SubjectFact = {
      ...MEMBER,
      tables: [...MEMBER.tables].reverse(),
      targets: [
        { name: 'x_users', retained: true },
        { name: 'files', retained: false },
      ],
    };
    const built = buildManifest({ app, subjects: [shuffled, { ...MEMBER, entity: 'account' }] });
    expect(built.subjects?.map((s) => s.entity)).toEqual(['account', 'member']);
    expect(built.subjects?.[1]?.tables.map((t) => t.entity)).toEqual([
      'comment',
      'invoice',
      'member',
    ]);
    expect(built.subjects?.[1]?.targets.map((t) => t.name)).toEqual(['files', 'x_users']);
  });
});
