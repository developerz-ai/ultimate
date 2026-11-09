// What a wait hands its bus's horizon on to: a NEW wait marks once and searches under that mark on
// every poll after it, and a refused event moves the search to the horizon of the search that
// found it. A stub bus records every `find`, so the wiring is checked and not the SQL behind it.

import { expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import type { EventLookup } from './steps';
import { isStepSuspension, stepRunner } from './steps';
import { memoryStepStore } from './steps-memory';

const T0 = 1_760_000_000_000;
const frozen: Clock = { now: () => new Date(T0) } as Clock;

type Find = Parameters<EventLookup['find']>;

test('a wait searches under its mark, then moves its cursor only forward: a refusal behind it is excluded by id', async () => {
  const finds: Find[] = [];
  let marks = 0;
  const answers: Awaited<ReturnType<EventLookup['find']>>[] = [
    undefined,
    // Past the cursor: the cursor moves to it, under the horizon of the search that found it.
    { id: 'ev-late', payload: { amount: 'twelve' }, publishedAt: T0 + 5, horizon: 'S1' },
    // BEHIND the cursor, owed through a horizon: excluded by id, the cursor stays.
    { id: 'ev-owed', payload: { amount: 'twelve' }, publishedAt: T0 - 5, horizon: 'S2' },
    undefined,
  ];
  const bus: EventLookup = {
    now: () => Promise.resolve(T0),
    mark: () => {
      marks += 1;
      return Promise.resolve({ at: T0, horizon: 'S0' });
    },
    find: (...args) => {
      finds.push(args);
      return Promise.resolve(answers.shift());
    },
  };
  const store = memoryStepStore();
  const attempt = () =>
    stepRunner({ runId: 'run-h', jobName: 'pay', store, clock: frozen, events: bus })
      .step.waitForEvent('approval', 'invoice.approved', {
        schema: t.object({ amount: t.number }),
        timeout: '1h',
      })
      .catch((error: unknown) => error);

  expect(isStepSuspension(await attempt())).toBe(true);
  for (const _refusal of [1, 2]) {
    const refused = await attempt();
    if (!isUltimateError(refused)) return expect.unreachable('expected X_JOB_EVENT_INVALID');
    expect(refused.code).toBe('X_JOB_EVENT_INVALID');
  }
  expect(isStepSuspension(await attempt())).toBe(true);

  // Marked ONCE: a re-poll keeps the line its wait began at.
  expect(marks).toBe(1);
  // The wait's own line rides every search, whatever the cursor does.
  const since = (refused?: string[]) => ({ at: T0, horizon: 'S0', refused });
  expect(finds).toEqual([
    ['invoice.approved', undefined, T0, undefined, 'S0', since()],
    ['invoice.approved', undefined, T0, undefined, 'S0', since()],
    ['invoice.approved', undefined, T0 + 5, 'ev-late', 'S1', since()],
    ['invoice.approved', undefined, T0 + 5, 'ev-late', 'S1', since(['ev-owed'])],
  ]);
});

test('a bus with no mark keeps the stamp alone: no horizon is invented', async () => {
  const finds: Find[] = [];
  const bus: EventLookup = {
    now: () => Promise.resolve(T0),
    find: (...args) => {
      finds.push(args);
      return Promise.resolve(undefined);
    },
  };
  const step = stepRunner({
    runId: 'run-n',
    jobName: 'pay',
    store: memoryStepStore(),
    clock: frozen,
    events: bus,
  }).step;
  const parked = await step
    .waitForEvent('approval', 'invoice.approved', { schema: t.object({}), timeout: '1h' })
    .catch((error: unknown) => error);
  expect(isStepSuspension(parked)).toBe(true);
  expect(finds).toEqual([
    [
      'invoice.approved',
      undefined,
      T0,
      undefined,
      undefined,
      { at: T0, horizon: undefined, refused: undefined },
    ],
  ]);
});
