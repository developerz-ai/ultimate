// The three polling loops name their streak one way — `jobs.<loop>.tick-failed` / `-recovered` —
// and hand it over as claim-loop hooks that work detached from their object.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installLogSink, UltimateError } from '@ultimat3/core';
import { tickStreak } from './tick-streak';

const lines: { msg: string; fields: Record<string, unknown> }[] = [];
let release: () => void = () => undefined;

beforeEach(() => {
  lines.length = 0;
  release = installLogSink((line) => {
    const { msg, ...fields } = JSON.parse(line) as { msg: string } & Record<string, unknown>;
    lines.push({ msg, fields });
  });
});

afterEach(() => release());

const down = (): UltimateError =>
  new UltimateError({ code: 'X_DB_UNAVAILABLE', cause: 'the server restarts', fix: 'wait' });

describe('tickStreak', () => {
  test('names the loop, carries its fields, and works as detached hooks', () => {
    const { onError, onPassed, onStart } = tickStreak('worker', { workerId: 'w1' });
    onError(down());
    onError(down());
    onPassed();
    onError(down());
    onStart();
    onPassed();
    expect(lines.map((line) => line.msg)).toEqual([
      'jobs.worker.tick-failed',
      'jobs.worker.tick-recovered',
      'jobs.worker.tick-failed',
    ]);
    expect(lines[0]?.fields).toMatchObject({ workerId: 'w1', code: 'X_DB_UNAVAILABLE' });
    expect(lines[1]?.fields).toMatchObject({ workerId: 'w1', failures: 2 });
  });

  test('each loop gets its own names', () => {
    for (const loop of ['scheduler', 'outbox'] as const) tickStreak(loop).onError(down());
    expect(lines.map((line) => line.msg)).toEqual([
      'jobs.scheduler.tick-failed',
      'jobs.outbox.tick-failed',
    ]);
  });
});
