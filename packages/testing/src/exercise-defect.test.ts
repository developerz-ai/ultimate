// A primitive answering a 5xx in the exercise pass: the record carries the error's CAUSE, the
// statement or the fields it names, with every value the call's input held under a credential key
// (or a `.sensitive()` field) masked — never only the code, which had to be reproduced by hand.

import { afterAll, describe, expect, test } from 'bun:test';
import { REDACTED, UltimateError } from '@ultimat3/core';
import { clearRegistry, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { DEFAULT_RETRY, job, t } from '@ultimat3/jobs';
import { ValidationFailedError } from '@ultimat3/schema';
import { runExercisePass } from './exercise';
import { defectDetail } from './exercise-defect';
import type { ExerciseRecord } from './exercise-report';
import type { SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

afterAll(() => {
  clearRegistry();
});

const orgs = entity('edf_orgs', { columns: { id: uuid().primaryKey(), name: text({ max: 40 }) } });
const driver = memoryDriver();
const writer: SeedWriter = {
  insert: async ({ row }) => {
    await driver.repo(orgs).insert(row as never);
  },
  update: async () => undefined,
  snapshot: async (rows) => rows.map(() => 'unchanged'),
};

const STATEMENT = 'insert into "edf_ledger" ("id", "payload") values ($1, $2::text::jsonb)';

job({
  name: 'edfStatementFails',
  tenant: (input) => input.edfOrgId,
  input: t.object({ edfOrgId: t.uuid, password: t.string.min(8) }),
  idempotencyKey: (input) => input.edfOrgId,
  retry: { ...DEFAULT_RETRY, attempts: 1 },
  run: async ({ input }) => {
    // The planted defect echoes a credential, as a server message can echo a bound value.
    throw new UltimateError({
      code: 'X_DB_STATEMENT_FAILED',
      cause: `[SQLSTATE 23502] null value in column "payload" (got ${input.password}) — statement: ${STATEMENT}`,
      fix: 'psql "$DATABASE_URL" -c "<the statement in cause>"',
    });
  },
});

const one = async (only: string): Promise<ExerciseRecord> => {
  const records = await runExercisePass({ entities: [orgs], writer, roles: () => [], only });
  expect(records).toHaveLength(1);
  return records[0] as ExerciseRecord;
};

describe(testName('unit', 'runExercisePass · a 5xx carries its cause'), () => {
  test('the record holds the cause and the statement, the credential masked', async () => {
    const record = await one('edfStatementFails');
    expect(record).toMatchObject({ outcome: 'unreached', code: 'X_DB_STATEMENT_FAILED' });
    expect(record.defect?.cause).toContain('null value in column "payload"');
    expect(record.defect?.cause).toContain(REDACTED);
    expect(record.defect?.statement).toBe(STATEMENT);
  });

  test('a validation failure names its fields; a sensitive field’s value is masked', async () => {
    const schema = t.object({ card: t.string.sensitive(), sku: t.string });
    const input = { card: '4242424242424242', sku: 'sku-1' };
    const error = new ValidationFailedError(
      [{ path: 'items.0.sku', message: `expected a known sku near ${input.card}` }],
      'output',
    );
    const detail = await defectDetail(error, input, schema);
    expect(detail?.fields).toEqual(['items.0.sku']);
    expect(detail?.cause).not.toContain(input.card);
    expect(detail?.cause).toContain('items.0.sku');
  });

  test('an uncoded throw carries none: its reason is the throw already', async () => {
    expect(await defectDetail(new TypeError('boom'), {}, t.object({}))).toBeUndefined();
  });
});
