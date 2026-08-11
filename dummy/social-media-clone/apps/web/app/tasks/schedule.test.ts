// unit — the cron declarations, and the two ways a task is refused.
//
// The refusals are the point. `tz` being required by the TYPE is only half the guard: generated
// code, a JS caller and a cast all reach `task()` at runtime, and a non-empty string is not a
// timezone. Both backstops are asserted here so neither can be relaxed without a red test.

import { expect, test } from 'bun:test';
import { task } from '@ultimat3/jobs';
import { scheduledApi } from '../../api/tasks';
import { hourlyDemoReset, hourlyMediaSweep } from './schedule';

test('a task declared without a tz is rejected — an unzoned cron is a bug waiting for March', () => {
  // @ts-expect-error — `tz` is REQUIRED by TaskDefinition. This line failing to error is itself
  // the regression: it would mean the type was relaxed, and `tsc` reports it right here.
  expect(() => task({ cron: '0 * * * *', enqueue: () => [] })).toThrow('X_INVARIANT');
  // And the runtime backstop, for the callers a type cannot reach — generated code, and a value
  // that arrived empty from configuration.
  expect(() => task({ cron: '0 * * * *', tz: '', enqueue: () => [] })).toThrow(/explicit IANA tz/);
});

test('a tz that is not in the IANA database is rejected, not silently resolved as UTC', () => {
  // `Bogota` looks like a zone and is not one. Accepted, every occurrence would resolve five
  // hours off, silently, forever.
  expect(() => task({ cron: '0 * * * *', tz: 'Bogota', enqueue: () => [] })).toThrow(
    /not a zone in the IANA tz database/,
  );
});

test('both tasks carry an explicit zone and a cadence', () => {
  expect(hourlyMediaSweep.cron).toBe('0 * * * *');
  expect(hourlyMediaSweep.tz).toBe('UTC');
  expect(hourlyDemoReset.cron).toBe('30 * * * *');
  expect(hourlyDemoReset.tz).toBe('UTC');
});

test('the export name is the task name — a cron nothing handed over would be anonymous-task-N', () => {
  expect(Object.keys(scheduledApi.tasks).sort()).toEqual(['hourlyDemoReset', 'hourlyMediaSweep']);
  expect(hourlyMediaSweep.name).toBe('hourlyMediaSweep');
  expect(Object.keys(scheduledApi.jobs).sort()).toEqual(['resetDemo', 'sweepOrphanMedia']);
});

test('a task only ENQUEUES: its descriptor names jobs, and the payload comes from the occurrence', () => {
  const descriptor = hourlyMediaSweep.describe();
  expect(descriptor.jobs).toEqual(['sweepOrphanMedia']);

  // 2026-03-01T12:00:00Z minus the one-hour claim grace.
  const occurrence = Date.parse('2026-03-01T12:00:00.000Z');
  const entries = hourlyMediaSweep.entries(occurrence);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.[1]).toEqual({ before: '2026-03-01T11:00:00.000Z' });

  // The SAME occurrence always builds the same payload — which is what makes a catch-up dispatch
  // describe the hour it fires for rather than the hour it happened to run in.
  expect(hourlyMediaSweep.entries(occurrence)).toEqual(entries);
  expect(hourlyMediaSweep.entries(occurrence + 3_600_000)[0]?.[1]).toEqual({
    before: '2026-03-01T12:00:00.000Z',
  });
});

test('the demo reset skips catch-up — every missed hour would do the identical deletion', () => {
  expect(hourlyDemoReset.catchUp).toBe('skip');
  expect(hourlyDemoReset.describe().jobs).toEqual(['resetDemo']);
});
