// A loop that fails every tick while its database restarts writes ONE line when the streak starts
// and ONE when it ends — never a line per tick (154 identical `jobs.scheduler.tick-failed` lines
// for one restart, production 2026-11-14).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installLogSink, UltimateError } from '@ultimat3/core';
import { failureStreak } from './failure-streak';

interface Line {
  readonly event: string;
  readonly level: string;
  readonly fields: Record<string, unknown>;
}

const lines: Line[] = [];
let releaseLogSink: () => void = () => undefined;

beforeEach(() => {
  lines.length = 0;
  releaseLogSink = installLogSink((line, level) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    lines.push({ event: String(parsed['msg'] ?? parsed['event']), level, fields: parsed });
  });
});

afterEach(() => {
  releaseLogSink();
});

const down = (): UltimateError =>
  new UltimateError({ code: 'X_DB_UNAVAILABLE', cause: 'the server restarts', fix: 'wait' });

describe('a failure streak', () => {
  test('logs the first failure, counts the rest, and logs once on recovery', () => {
    const streak = failureStreak('jobs.scheduler.tick-failed', 'jobs.scheduler.tick-recovered');
    for (let tick = 0; tick < 154; tick += 1) streak.failed(down(), { workerId: 'w1' });

    expect(lines.map((line) => line.event)).toEqual(['jobs.scheduler.tick-failed']);
    expect(lines[0]?.level).toBe('error');
    // The actionable half of the error, and the caller's fields, on the one line there is.
    expect(lines[0]?.fields).toMatchObject({
      code: 'X_DB_UNAVAILABLE',
      fix: 'wait',
      workerId: 'w1',
    });

    streak.passed();
    expect(lines.map((line) => line.event)).toEqual([
      'jobs.scheduler.tick-failed',
      'jobs.scheduler.tick-recovered',
    ]);
    expect(lines[1]?.level).toBe('info');
    expect(lines[1]?.fields).toMatchObject({ failures: 154, workerId: 'w1' });
  });

  test('a pass with no streak behind it writes nothing', () => {
    const streak = failureStreak('jobs.worker.tick-failed', 'jobs.worker.tick-recovered');
    streak.passed();
    streak.passed();
    expect(lines).toEqual([]);
  });

  test('a second streak after a recovery is news again', () => {
    const streak = failureStreak('jobs.outbox.tick-failed', 'jobs.outbox.tick-recovered');
    streak.failed(new TypeError('connection reset'));
    streak.passed();
    streak.failed(new TypeError('connection reset'));
    streak.failed(new TypeError('connection reset'));
    streak.passed();
    expect(lines.map((line) => [line.event, line.fields['failures']])).toEqual([
      ['jobs.outbox.tick-failed', undefined],
      ['jobs.outbox.tick-recovered', 1],
      ['jobs.outbox.tick-failed', undefined],
      ['jobs.outbox.tick-recovered', 2],
    ]);
  });
});

describe('a streak whose cause changes', () => {
  const missingColumn = (): UltimateError =>
    new UltimateError({
      code: 'X_DB_QUERY_FAILED',
      cause: 'column does not exist',
      fix: 'migrate',
    });

  test('a new code closes the old streak with its count and is logged as its own failure', () => {
    const streak = failureStreak('jobs.scheduler.tick-failed', 'jobs.scheduler.tick-recovered');
    for (let tick = 0; tick < 3; tick += 1) streak.failed(down());
    for (let tick = 0; tick < 4; tick += 1) streak.failed(missingColumn());
    streak.passed();

    expect(lines.map((line) => line.event)).toEqual([
      'jobs.scheduler.tick-failed',
      'jobs.scheduler.tick-failed',
      'jobs.scheduler.tick-recovered',
    ]);
    expect(lines[1]?.fields).toMatchObject({
      code: 'X_DB_QUERY_FAILED',
      previous: { code: 'X_DB_UNAVAILABLE', failures: 3 },
    });
    expect(lines[2]?.fields).toMatchObject({ failures: 4 });
  });

  test('an uncoded failure changes cause when its message does', () => {
    const streak = failureStreak('jobs.worker.tick-failed', 'jobs.worker.tick-recovered');
    streak.failed(new TypeError('connection reset'));
    streak.failed(new TypeError('connection reset'));
    streak.failed(new TypeError('relation "x_jobs" does not exist'));
    expect(lines.map((line) => line.fields['previous'])).toEqual([
      undefined,
      { error: 'TypeError: connection reset', failures: 2 },
    ]);
  });

  test('reset() forgets an open streak: a restarted loop opens its own', () => {
    const streak = failureStreak('jobs.worker.tick-failed', 'jobs.worker.tick-recovered');
    streak.failed(down());
    streak.reset();
    streak.passed();
    streak.failed(down());
    expect(lines.map((line) => line.event)).toEqual([
      'jobs.worker.tick-failed',
      'jobs.worker.tick-failed',
    ]);
  });
});
