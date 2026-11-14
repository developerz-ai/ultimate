// An outage is one fact: said on failures 1, 2, 4, 8, …, at the level its owner chose, and once
// more when it ends — never once per retry. A streak is the same fact keyed on its cause: one line
// when it opens or its cause changes, one when it ends (154 identical `jobs.scheduler.tick-failed`
// lines for one database restart, production 2026-11-14).

import { afterEach, describe, expect, test } from 'bun:test';
import { UltimateError } from './errors';
import { installLogSink, type LogLevel } from './logger';
import { failureFields, failureStreak, isOutageMilestone, outageLog } from './outage-log';

interface Line {
  readonly level: LogLevel;
  readonly msg: string;
  readonly fields: Record<string, unknown>;
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

function capture(): Line[] {
  const lines: Line[] = [];
  const releaseLogSink = installLogSink((line, level) => {
    const { msg, ...fields } = JSON.parse(line) as { msg: string } & Record<string, unknown>;
    lines.push({ level, msg, fields });
  });
  restore = () => releaseLogSink();
  return lines;
}

describe('outageLog', () => {
  test('a milestone is 1, 2, 4, 8, … and nothing else', () => {
    const said = Array.from({ length: 20 }, (_, index) => index).filter(isOutageMilestone);
    expect(said).toEqual([1, 2, 4, 8, 16]);
  });

  test('100 failures are 7 lines at the chosen level, each carrying the count', () => {
    const lines = capture();
    const outage = outageLog({ event: 'bus.away', level: 'warn' });
    const said: boolean[] = [];
    for (let failure = 0; failure < 100; failure += 1) said.push(outage.failed({ topic: 'room' }));
    expect(lines.map((line) => [line.level, line.msg, line.fields['failures']])).toEqual(
      [1, 2, 4, 8, 16, 32, 64].map((failures) => ['warn', 'bus.away', failures]),
    );
    expect(lines[0]?.fields['topic']).toBe('room');
    expect(said.filter(Boolean)).toHaveLength(7);
    expect(outage.failures).toBe(100);
  });

  test('`error` is written at error', () => {
    const lines = capture();
    outageLog({ event: 'sync.bus_away', level: 'error' }).failed();
    expect(lines.map((line) => line.level)).toEqual(['error']);
  });

  test('recovery is ONE info line with the count, and the next outage starts at 1 again', () => {
    const lines = capture();
    const outage = outageLog({ event: 'bus.away', level: 'error' });
    for (let failure = 0; failure < 5; failure += 1) outage.failed();
    outage.recovered({ bus: 'nats' });
    outage.recovered();
    expect(lines.slice(3)).toEqual([
      {
        level: 'info',
        msg: 'bus.away recovered',
        fields: expect.objectContaining({ after: 5, bus: 'nats' }),
      },
    ]);
    expect(outage.failures).toBe(0);
    expect(outage.failed()).toBe(true);
    expect(lines.at(-1)?.fields['failures']).toBe(1);
  });

  test('a recovery with nothing failed says nothing', () => {
    const lines = capture();
    outageLog({ event: 'bus.away', level: 'warn' }).recovered();
    expect(lines).toEqual([]);
  });
});

const down = (): UltimateError =>
  new UltimateError({ code: 'X_DB_UNAVAILABLE', cause: 'the server restarts', fix: 'wait' });

const missingColumn = (): UltimateError =>
  new UltimateError({ code: 'X_DB_QUERY_FAILED', cause: 'column does not exist', fix: 'migrate' });

const tick = {
  event: 'jobs.scheduler.tick-failed',
  recoveredEvent: 'jobs.scheduler.tick-recovered',
};

describe('failureStreak', () => {
  test('logs the first failure, counts the rest, and logs once on recovery', () => {
    const lines = capture();
    const streak = failureStreak({ ...tick, fields: { workerId: 'w1' } });
    for (let failure = 0; failure < 154; failure += 1) streak.failed(down());
    expect(streak.failures).toBe(154);

    expect(lines.map((line) => [line.level, line.msg])).toEqual([
      ['error', 'jobs.scheduler.tick-failed'],
    ]);
    // The actionable half of the error, and the caller's fields, on the one line there is.
    expect(lines[0]?.fields).toMatchObject({
      code: 'X_DB_UNAVAILABLE',
      cause: 'the server restarts',
      fix: 'wait',
      workerId: 'w1',
    });

    streak.passed();
    expect(lines.slice(1)).toEqual([
      {
        level: 'info',
        msg: 'jobs.scheduler.tick-recovered',
        fields: expect.objectContaining({ failures: 154, workerId: 'w1' }),
      },
    ]);
    expect(streak.failures).toBe(0);
  });

  test("the level is the owner's, and per-failure fields stay on the failure line", () => {
    const lines = capture();
    const streak = failureStreak({
      event: 'db.listen.redial_failed',
      recoveredEvent: 'db.listen.redialed',
      level: 'warn',
      fields: { channel: 'x_jobs' },
    });
    expect(streak.failed(new TypeError('refused'), { attempt: 1 })).toBe(true);
    expect(streak.failed(new TypeError('refused'), { attempt: 2 })).toBe(false);
    streak.passed();
    expect(lines.map((line) => [line.level, line.msg, line.fields['attempt']])).toEqual([
      ['warn', 'db.listen.redial_failed', 1],
      ['info', 'db.listen.redialed', undefined],
    ]);
    expect(lines[1]?.fields).toMatchObject({ channel: 'x_jobs', failures: 2 });
  });

  test('a pass with no streak behind it writes nothing', () => {
    const lines = capture();
    const streak = failureStreak(tick);
    streak.passed();
    streak.passed();
    expect(lines).toEqual([]);
  });

  test('a second streak after a recovery is news again', () => {
    const lines = capture();
    const streak = failureStreak(tick);
    streak.failed(new TypeError('connection reset'));
    streak.passed();
    streak.failed(new TypeError('connection reset'));
    streak.failed(new TypeError('connection reset'));
    streak.passed();
    expect(lines.map((line) => [line.msg, line.fields['failures']])).toEqual([
      ['jobs.scheduler.tick-failed', undefined],
      ['jobs.scheduler.tick-recovered', 1],
      ['jobs.scheduler.tick-failed', undefined],
      ['jobs.scheduler.tick-recovered', 2],
    ]);
  });

  test('a new code closes the old streak with its count and is logged as its own failure', () => {
    const lines = capture();
    const streak = failureStreak(tick);
    for (let failure = 0; failure < 3; failure += 1) streak.failed(down());
    for (let failure = 0; failure < 4; failure += 1) streak.failed(missingColumn());
    streak.passed();
    expect(lines.map((line) => line.msg)).toEqual([
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
    const lines = capture();
    const streak = failureStreak(tick);
    streak.failed(new TypeError('connection reset'));
    streak.failed(new TypeError('connection reset'));
    streak.failed(new TypeError('relation "x_jobs" does not exist'));
    expect(lines.map((line) => line.fields['previous'])).toEqual([
      undefined,
      { error: 'TypeError: connection reset', failures: 2 },
    ]);
  });

  test('reset() forgets an open streak: a restarted loop opens its own', () => {
    const lines = capture();
    const streak = failureStreak(tick);
    streak.failed(down());
    streak.reset();
    streak.passed();
    streak.failed(down());
    expect(lines.map((line) => line.msg)).toEqual([
      'jobs.scheduler.tick-failed',
      'jobs.scheduler.tick-failed',
    ]);
  });
});

describe('failureFields', () => {
  test('a coded error carries its code, cause and fix; anything else its rendered message', () => {
    expect(failureFields(down())).toEqual({
      error: expect.stringContaining('X_DB_UNAVAILABLE'),
      code: 'X_DB_UNAVAILABLE',
      cause: 'the server restarts',
      fix: 'wait',
    });
    expect(failureFields(new TypeError('reset'))).toEqual({ error: 'TypeError: reset' });
  });
});
