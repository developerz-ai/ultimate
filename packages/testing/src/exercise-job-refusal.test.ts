// Single responsibility: a job's failure is judged by the rule an action's is — a coded refusal
// under 500 is the job answering "no", never X_CONTRACT_DEFECT; an uncoded throw or a 5xx still is.
import { afterAll, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { clearRegistry, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { registerErrorStatus } from '@ultimat3/http';
import { DEFAULT_RETRY, job, t } from '@ultimat3/jobs';
import { runExercisePass } from './exercise';
import type { ExerciseRecord } from './exercise-report';
import type { SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

afterAll(() => {
  clearRegistry();
});

const orgs = entity('ejr_orgs', { columns: { id: uuid().primaryKey(), name: text({ max: 40 }) } });
const driver = memoryDriver();
const writer: SeedWriter = {
  insert: async ({ row }) => {
    await driver.repo(orgs).insert(row as never);
  },
  update: async () => undefined,
  snapshot: async (rows) => rows.map(() => 'unchanged'),
};

registerErrorStatus({ X_EJR_SLOT_TAKEN: 409, X_EJR_VENDOR_DOWN: 502 });

const refusing = (name: string, raise: () => never) =>
  job({
    name,
    tenant: (input) => input.ejrOrgId,
    input: t.object({ ejrOrgId: t.uuid }),
    idempotencyKey: (input) => input.ejrOrgId,
    retry: { ...DEFAULT_RETRY, attempts: 1 },
    run: async () => raise(),
  });

const coded = (code: string) => (): never => {
  throw new UltimateError({ code, cause: 'the slot is held', fix: 'pick another slot' });
};
refusing('ejrConflict', coded('X_EJR_SLOT_TAKEN'));
refusing('ejrServerError', coded('X_EJR_VENDOR_DOWN'));
refusing('ejrUncoded', () => {
  throw new TypeError('undefined is not an object');
});

const one = async (only: string): Promise<ExerciseRecord> => {
  const records = await runExercisePass({ entities: [orgs], writer, roles: () => [], only });
  expect(records).toHaveLength(1);
  return records[0] as ExerciseRecord;
};

describe(testName('unit', 'runExercisePass · a job refusing'), () => {
  test('a coded 4xx refusal is the job answering no, carried with its code: not a defect', async () => {
    const record = await one('ejrConflict');
    expect(record).toMatchObject({ kind: 'job', outcome: 'unreached', code: 'X_EJR_SLOT_TAKEN' });
  });

  test('a coded 5xx is a defect, under its own code', async () => {
    const record = await one('ejrServerError');
    expect(record).toMatchObject({ kind: 'job', outcome: 'unreached', code: 'X_EJR_VENDOR_DOWN' });
    expect(record.reason).toContain('a 502');
  });

  test('an uncoded throw is X_CONTRACT_DEFECT', async () => {
    const record = await one('ejrUncoded');
    expect(record).toMatchObject({ kind: 'job', outcome: 'unreached', code: 'X_CONTRACT_DEFECT' });
    expect(record.reason).toContain('TypeError');
  });
});
