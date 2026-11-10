// `reproduce` and `reproJob`: a captured request replays to the same code only because the rows it
// read were seeded and its masked field was stood in for; a dead job replays its completed steps
// from storage and fails again at the same step.

import { afterAll, afterEach, expect, test } from 'bun:test';
import { action, resetActions } from '@ultimat3/action';
import { registerActions } from '@ultimat3/action/loader';
import type { FailureBundle } from '@ultimat3/core';
import { REDACTED, UltimateError, userActor } from '@ultimat3/core';
import { database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { job, t as jt } from '@ultimat3/jobs';
import { resetJobDriver } from '@ultimat3/jobs/adapter';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { type RunJobs, testJobs } from './fixture-jobs';
import { isolateEntityRegistry } from './registry-isolation';
import { reproduce, reproJob } from './repro';

const restoreEntities = isolateEntityRegistry();
const notes = entity('repro_notes', {
  columns: { id: uuid().primaryKey(), title: text(), apiKey: text() },
});
const driver = memoryDriver();
const table = database({ notes }, { driver }).notes;
const NOTE = '0198c1a0-0000-7000-8000-0000000000aa';

const openNote = action({
  input: t.object({ noteId: t.uuid, pin: t.string.sensitive() }),
  output: t.object({ ok: t.boolean }),
  policy: allow(),
  handle: async ({ input }) => {
    const found = await table.where({ id: input.noteId }).one();
    if (found === null) {
      throw new UltimateError({ code: 'X_REPRO_NOTE_MISSING', cause: 'gone', fix: 'x verify' });
    }
    if (found.title === 'boom' && input.pin.length > 0) {
      throw new UltimateError({ code: 'X_PLANTED_FAILURE', cause: 'planted', fix: 'x verify' });
    }
    return { ok: true };
  },
});
registerActions({ openNote });

afterAll(() => {
  resetActions();
  restoreEntities();
});

const bundle: FailureBundle = {
  id: 'b1',
  fingerprint: 'f1',
  code: 'X_PLANTED_FAILURE',
  operation: null,
  primitive: 'action',
  name: 'openNote',
  at: Date.parse('2026-11-06T10:00:00.000Z'),
  requestId: null,
  traceId: null,
  build: null,
  input: { noteId: NOTE, pin: REDACTED },
  masked: ['pin'],
  actor: { kind: 'user', id: 'u1', orgId: null, roles: [], scopes: [], permissions: [] },
  flags: {},
  reads: [
    {
      entity: 'repro_notes',
      row: { id: NOTE, title: 'boom', apiKey: REDACTED },
      masked: ['apiKey'],
    },
  ],
  truncated: false,
};

test('a captured request fails again with its code once its reads are seeded', async () => {
  const outcome = await reproduce(bundle, { driver });
  expect(outcome.code).toBe('X_PLANTED_FAILURE');
});

test('without the captured rows it fails some other way — the read set is the reproduction', async () => {
  driver.reset?.();
  const outcome = await reproduce(bundle);
  expect(outcome.code).toBe('X_REPRO_NOTE_MISSING');
});

test('a name nothing registered is the outcome, not a throw', async () => {
  const outcome = await reproduce({ ...bundle, name: 'nosuchAction' });
  expect(outcome.failure).toContain('nosuchAction');
});

let runJobs: RunJobs | undefined;
afterEach(async () => {
  await runJobs?.[Symbol.asyncDispose]();
  runJobs = undefined;
  resetJobDriver();
});

test('a dead job replays its completed steps from storage and fails at the same step', async () => {
  const ran: string[] = [];
  job<{ id: string }>({
    name: 'repro-three-steps',
    input: jt.object({ id: jt.string }),
    tenant: 'none',
    idempotencyKey: (input) => input.id,
    retry: { attempts: 1, jitter: 'none' },
    run: async ({ step }) => {
      const a = await step.run('fetch', async () => {
        ran.push('fetch');
        return 2;
      });
      const b = await step.run('double', async () => {
        ran.push('double');
        return a * 2;
      });
      await step.run('charge', async () => {
        ran.push('charge');
        if (b === 40)
          throw new UltimateError({ code: 'X_PLANTED_FAILURE', cause: 'x', fix: 'x verify' });
      });
    },
  });
  runJobs = await testJobs();
  const outcome = await reproJob(runJobs, {
    jobId: 'j1',
    name: 'repro-three-steps',
    input: { id: 'a' },
    masked: [],
    steps: [
      { name: 'fetch', output: 20 },
      { name: 'double', output: 40 },
    ],
    code: 'X_PLANTED_FAILURE',
    step: 'charge',
  });
  expect(ran).toEqual(['charge']);
  expect([outcome.code, outcome.step]).toEqual(['X_PLANTED_FAILURE', 'charge']);
  expect(userActor({ id: 'x' }).kind).toBe('user');
});
