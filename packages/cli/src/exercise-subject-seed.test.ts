// The subject proof seeds one graph per subject on one scratch database. Each seed reset the app's
// factories, so a factory value built from the row index (`code: `c${index}``) on a unique column
// repeated the first subject's rows and the second subject's seed died on the key: every subject
// after the first erred instead of proving. Real PGlite, so the unique key is the database's.

import { afterAll, describe, expect, test } from 'bun:test';
import { generateMigration, migrate, pgliteClient } from '@ultimat3/db';
import type { EntityCore } from '@ultimat3/entity';
import { clearRegistry, entity, postgresDriver, text, uuid } from '@ultimat3/entity';
import { defineSubject, resetSubjects } from '@ultimat3/jobs';
import { defineFactory } from '@ultimat3/testing';
import { subjectProofFindings } from './exercise-subject';

const people = entity('xsp_people', {
  columns: { id: uuid().primaryKey(), email: text({ max: 80 }) },
});
const members = entity('xsp_members', {
  columns: { id: uuid().primaryKey(), handle: text({ max: 80 }) },
});
const codes = entity('xsp_codes', {
  columns: { id: uuid().primaryKey(), code: text({ max: 40 }).unique() },
});
const cores = { xsp_people: people, xsp_members: members, xsp_codes: codes } as unknown as Readonly<
  Record<string, EntityCore>
>;
const factories = {
  xsp_codes: defineFactory<{ code: string }>(codes, {
    defaults: (index) => ({ code: `c${index}` }),
  }),
};

afterAll(() => {
  clearRegistry();
  resetSubjects();
});

describe('unit · subjectProofFindings, one database', () => {
  test("a second subject's seed continues the first's row positions: no unique value repeats", async () => {
    const client = pgliteClient();
    try {
      const up = generateMigration({
        entities: [people.$describe(), members.$describe(), codes.$describe()],
        name: 'subject_seed',
        now: new Date('2026-11-08T00:00:00.000Z'),
      }).up;
      await migrate({
        migrations: [{ id: '1_subject_seed', name: 'subject_seed', up, down: '' }],
        client,
        lock: false,
      });
      const driver = postgresDriver({ client });
      const key = (input: { id: string }) => input.id;
      const subjects = [
        defineSubject(people, { driver, key, tables: { xsp_people: 'delete' } }),
        defineSubject(members, { driver, key, tables: { xsp_members: 'delete' } }),
      ];
      expect(await subjectProofFindings(subjects as never, cores, client, factories)).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
