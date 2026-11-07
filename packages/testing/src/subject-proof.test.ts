// `subjectProof` on generated rows: a complete declaration proves clean, and each planted miss is
// red with its table named — an untreated table, an anonymize that left a column, and a raw copy
// of the subject's value in a table with no key to them.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import {
  ctxOf,
  isUltimateError,
  runWithContext,
  serviceActor,
  UltimateError,
} from '@ultimat3/core';
import type { AnyColumn, Driver, EntityCore } from '@ultimat3/entity';
import {
  CROSS_TENANT_SCOPE,
  clearRegistry,
  crossTenant,
  entity,
  memoryDriver,
  text,
  uuid,
} from '@ultimat3/entity';
import type { SubjectTreatment } from '@ultimat3/jobs';
import { defineSubject, resetSubjects } from '@ultimat3/jobs';
import type { SeedEntity } from './seed-graph-shape';
import { entitySeedWriter } from './seed-writer';
import { subjectProof } from './subject-proof';

const people = entity('spf_people', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    email: text({ max: 80 }),
    name: text({ max: 80 }),
  },
});
const notes = entity('spf_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    personId: uuid().references(() => people.id, { onDelete: 'cascade' }),
    body: text({ max: 80 }),
  },
});
const logs = entity('spf_logs', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), line: text({ max: 200 }) },
});
const ALL = { people, notes, logs };

afterEach(() => resetSubjects());
afterAll(() => clearRegistry());

const codes = (problems: readonly unknown[]) =>
  problems.map((p) => (isUltimateError(p) ? `${p.code} ${String(p.meta?.['table'] ?? '')}` : 'x'));

/** Every stored row, unscoped: an operator actor holding the cross-tenant scope. */
const operator = serviceActor({ id: 'proof-reader', scopes: [CROSS_TENANT_SCOPE] });
const reader = (driver: Driver) => (one: SeedEntity) =>
  runWithContext(ctxOf({ actor: operator }), () =>
    crossTenant('the proof searches every tenant', async () => {
      const core = one as unknown as EntityCore<Record<string, unknown>>;
      return (await driver.repo(core).findMany({ limit: 500 })).rows as readonly Record<
        string,
        unknown
      >[];
    }),
  );

const prove = async (tables: Readonly<Record<string, SubjectTreatment>>, copy = false) => {
  const driver = memoryDriver();
  const subject = defineSubject(people, { driver, key: (i: { id: string }) => i.id, tables });
  const writer = entitySeedWriter({ entities: ALL, driver });
  let copied = !copy;
  return subjectProof(subject, {
    entities: Object.values(ALL) as unknown as readonly SeedEntity[],
    // Row by row, no `insertMany`: the planted copy follows the person's own insert.
    writer: {
      update: (update) => writer.update(update),
      snapshot: (rows) => writer.snapshot(rows),
      async insert(row) {
        await writer.insert(row);
        if (copied || row.entity !== 'spf_people') return;
        copied = true;
        // The planted miss: the person's address copied into a table with no key to them.
        await writer.insert({
          entity: 'spf_logs',
          table: 'spf_logs',
          tenant: row.tenant,
          row: { id: LOG_ID, orgId: row.tenant, line: `mailed ${String(row.row['email'])}` },
        });
      },
    },
    read: (one) => reader(driver)(one),
  });
};

const LOG_ID = '00000000-0000-7000-8000-00000000ffff';

describe('unit · subjectProof', () => {
  test('a complete declaration proves clean: no seeded value of the person survives', async () => {
    const result = await prove({ spf_people: 'delete', spf_notes: 'delete' });
    expect(result.key).toBeDefined();
    expect(result.problems).toEqual([]);
  });

  test('an untreated table is red before any row is written', async () => {
    const result = await prove({ spf_people: 'delete' });
    expect(codes(result.problems)).toEqual(['X_SUBJECT_TABLE_UNDECLARED spf_notes']);
  });

  test('an anonymize that left one column is red, naming the column', async () => {
    const result = await prove({
      spf_people: { anonymize: { email: 'erased@invalid' } },
      spf_notes: 'delete',
    });
    expect(codes(result.problems)).toEqual(['X_SUBJECT_ERASE_INCOMPLETE spf_people']);
    expect(result.problems[0]?.cause).toContain('spf_people.name');
  });

  // The pass's own rule (`deferredMayStayNull`): a nullable cycle key the database refuses to
  // set — a trigger no declaration carries — stays null, and the proof goes on over the rest.
  test('a deferred cycle key the database refuses to set stays null: the proof still runs', async () => {
    const teams = entity('spf_a_teams', {
      columns: {
        id: uuid().primaryKey(),
        orgId: uuid().tenant(),
        captainId: uuid()
          .references((): AnyColumn => players.id)
          .nullable(),
      },
    });
    const players = entity('spf_b_players', {
      columns: {
        id: uuid().primaryKey(),
        orgId: uuid().tenant(),
        teamId: uuid().references((): AnyColumn => teams.id),
      },
    });
    const driver = memoryDriver();
    const subject = defineSubject(people, {
      driver,
      key: (i: { id: string }) => i.id,
      tables: { spf_people: 'delete', spf_notes: 'delete' },
    });
    const writer = entitySeedWriter({ entities: { ...ALL, teams, players }, driver });
    let refused = 0;
    const result = await subjectProof(subject, {
      entities: [...Object.values(ALL), teams, players] as unknown as readonly SeedEntity[],
      writer: {
        insert: (row) => writer.insert(row),
        snapshot: (rows) => writer.snapshot(rows),
        update: () => {
          refused += 1;
          return Promise.reject(
            new UltimateError({
              code: 'X_DB_STATEMENT_FAILED',
              cause: 'spf_a_teams rows are never updated',
              fix: 'see the trigger',
            }),
          );
        },
      },
      read: (one) => reader(driver)(one),
    });
    expect(refused).toBeGreaterThan(0);
    expect(result.problems).toEqual([]);
  });

  test('a raw copy of the email in a table with no key to the person is red', async () => {
    const result = await prove({ spf_people: 'delete', spf_notes: 'delete' }, true);
    expect(codes(result.problems)).toEqual(['X_SUBJECT_ERASE_INCOMPLETE spf_logs']);
    expect(result.problems[0]?.cause).toContain('spf_logs.line');
  });
});
