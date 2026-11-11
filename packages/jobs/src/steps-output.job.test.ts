// A step's answer on a real `jsonb` column, against the memory store: one value, one key order, one
// refusal. The memory store never meets `jsonb`, so a value only Postgres refuses or reorders is a
// run that passes every test and differs in production. Opt-in (`.job.`): booting Postgres costs.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { postgresJobDriver } from './driver-pg';
import type { EmbeddedPg } from './embedded-pg-fixture';
import { embeddedPg } from './embedded-pg-fixture';
import type { StepStore } from './steps';
import { stepRunner } from './steps';
import { memoryStepStore } from './steps-memory';

// Boot belongs to the fixture hooks; serialization assertions keep the runner's default budget.
const PGLITE_BOOT_MS = 120_000;

let pg: EmbeddedPg;

beforeEach(async () => {
  pg = await embeddedPg();
  await pg.reset();
}, PGLITE_BOOT_MS);

afterAll(async () => {
  await (await embeddedPg()).close();
}, PGLITE_BOOT_MS);

const stores = (): readonly (readonly ['memory' | 'postgres', StepStore])[] => [
  ['memory', memoryStepStore()],
  ['postgres', postgresJobDriver({ executor: pg.executor }).steps],
];

/** `x_job_steps.run_id` is a uuid, so the ids are real ones. */
const RUN = {
  memory: '00000000-0000-4000-8000-000000000001',
  postgres: '00000000-0000-4000-8000-000000000002',
} as const;

describe('one step, one answer, on either store', () => {
  test('a NUL refuses with the code before the store, and the body ran once', async () => {
    for (const [label, store] of stores()) {
      let runs = 0;
      const attempt = () =>
        stepRunner({ runId: RUN[label], jobName: 'j', store })
          .step.run('s', () => {
            runs += 1;
            return 'vendor\u0000note';
          })
          .catch((error: unknown) => error);
      const thrown = await attempt();
      if (!isUltimateError(thrown)) return expect.unreachable(`${label}: expected a coded refusal`);
      expect(thrown.code).toBe('X_STEP_OUTPUT_UNSERIALIZABLE');
      expect(runs).toBe(1);
    }
  });

  test('a lone surrogate refuses the same way', async () => {
    for (const [label, store] of stores()) {
      const thrown = await stepRunner({ runId: RUN[label], jobName: 'j', store })
        .step.run('s', () => 'x\ud83d')
        .catch((error: unknown) => error);
      expect(thrown).toBeUltimateError('X_STEP_OUTPUT_UNSERIALIZABLE');
    }
  });

  test('the first run and the replay read keys in one order', async () => {
    const value = { zebra: 1, a: 2, bb: 3, é: 4, z: { yy: 1, x: 2 }, 10: 'n', 9: 'm' };
    for (const [label, store] of stores()) {
      const attempt = () =>
        stepRunner({ runId: RUN[label], jobName: 'j', store }).step.run('s', () => value);
      const first = await attempt();
      const replay = await attempt();
      expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
    }
  });
});
