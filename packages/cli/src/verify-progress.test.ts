// The gate's stderr progress, on a fake clock and a fake timer: a line per finished step and a
// heartbeat while one runs, in every render mode, so a harness that kills on silence never sees a
// healthy gate go quiet. No test here sleeps.

import { expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { msg } from './messages';
import type { Every } from './verify-progress';
import { elapsedLabel, HEARTBEAT_MS, stepLine, withVerifyProgress } from './verify-progress';
import { runVerify } from './verify-run';
import type { VerifyContext, VerifyStep } from './verify-step';

/** A timer that fires only when the test says, and records whether it was stopped. */
const fakeEvery = () => {
  const timer = { tick: (): void => {}, intervalMs: 0, stopped: false };
  const every: Every = (tick, intervalMs) => {
    timer.tick = tick;
    timer.intervalMs = intervalMs;
    return () => {
      timer.stopped = true;
    };
  };
  return { timer, every };
};

const runner: VerifyContext['runner'] = async () => ({
  command: ['true'],
  code: 0,
  ok: true,
  stdout: '',
  stderr: '',
  durationMs: 0,
});

test('one finished step is one line of JSON: the step, its verdict, its milliseconds', () => {
  const line = stepLine({ name: 'lint', ok: true, durationMs: 21_987, findings: [] });
  expect(line).not.toContain('\n');
  expect(JSON.parse(line)).toEqual({ step: 'lint', ok: true, ms: 21_987 });
});

test('a step that did not apply says so, and a red one is ok:false', () => {
  expect(
    JSON.parse(stepLine({ name: 'e2e', ok: true, durationMs: 0, skipped: true, findings: [] })),
  ).toEqual({ step: 'e2e', ok: true, ms: 0, skipped: true });
  expect(
    JSON.parse(stepLine({ name: 'unit', ok: false, durationMs: 9, skipped: false, findings: [] })),
  ).toEqual({ step: 'unit', ok: false, ms: 9 });
});

test('repro: a run writes progress as each step finishes and while one runs, not only at the end', async () => {
  // The defect: without `--json` the gate wrote nothing until it ended, so a harness that kills
  // after 30 silent minutes killed green runs. Here the run is the real `runVerify` loop.
  const written: string[] = [];
  const clock = frozenClock();
  const { timer, every } = fakeEvery();
  const seenBySecond: string[] = [];
  const steps: readonly VerifyStep[] = [
    { name: 'lint', summary: 'lint', run: async () => ({ ok: true, findings: [] }) },
    {
      name: 'unit',
      summary: 'unit',
      run: async () => {
        // Mid-step: the first step's line is already out, and a long step still makes noise.
        seenBySecond.push(...written);
        clock.advance(HEARTBEAT_MS + 5_000);
        timer.tick();
        return { ok: true, findings: [] };
      },
    },
  ];
  await withVerifyProgress(
    (line) => written.push(line),
    (progress) => runVerify(steps, { root: '/nowhere', runner, ...progress }),
    { clock, every },
  );
  expect(seenBySecond.map((line) => JSON.parse(line).step)).toEqual(['lint']);
  expect(written).toHaveLength(3);
  expect(JSON.parse(written[0] ?? '').step).toBe('lint');
  expect(written[1]).toBe(msg('cli.verify.stillRunning', { steps: 'unit (1m 5s)' }));
  expect(JSON.parse(written[2] ?? '').step).toBe('unit');
});

test('the heartbeat names every step still running, each with its own elapsed time', async () => {
  const written: string[] = [];
  const clock = frozenClock();
  const { timer, every } = fakeEvery();
  await withVerifyProgress(
    (line) => written.push(line),
    async ({ onStepStart, onStep }) => {
      timer.tick(); // nothing has started: silence is not a heartbeat's to fill
      onStepStart('live');
      clock.advance(4 * 60_000);
      onStepStart('lint');
      clock.advance(30_000);
      timer.tick();
      onStep({ name: 'lint', ok: true, durationMs: 30_000, findings: [] });
      onStep({ name: 'live', ok: true, durationMs: 270_000, findings: [] });
      timer.tick(); // everything finished: no heartbeat
    },
    { clock, every },
  );
  expect(timer.intervalMs).toBe(HEARTBEAT_MS);
  expect(written.filter((line) => !line.startsWith('{'))).toEqual([
    msg('cli.verify.stillRunning', { steps: 'live (4m 30s), lint (30s)' }),
  ]);
});

test('the heartbeat is stopped when the run resolves and when it throws', async () => {
  const resolved = fakeEvery();
  expect(
    await withVerifyProgress(
      () => {},
      async () => 7,
      { every: resolved.every },
    ),
  ).toBe(7);
  expect(resolved.timer.stopped).toBe(true);

  const thrown = fakeEvery();
  const failure = new RangeError('the gate itself threw');
  const outcome = await withVerifyProgress(
    () => {},
    async () => {
      throw failure;
    },
    { every: thrown.every },
  ).catch((error: unknown) => error);
  expect(outcome).toBe(failure);
  expect(thrown.timer.stopped).toBe(true);
});

test('a heartbeat whose write throws (stderr closed) does not escape the timer', async () => {
  const { timer, every } = fakeEvery();
  const epipe = new RangeError('EPIPE');
  await withVerifyProgress(
    () => {
      throw epipe;
    },
    async ({ onStepStart }) => {
      onStepStart('unit');
      expect(() => timer.tick()).not.toThrow();
    },
    { every },
  );
});

test('elapsed reads as minutes and seconds, seconds alone under a minute', () => {
  expect(elapsedLabel(0)).toBe('0s');
  expect(elapsedLabel(59_999)).toBe('59s');
  expect(elapsedLabel(60_000)).toBe('1m 0s');
  expect(elapsedLabel(29 * 60_000 + 48_000)).toBe('29m 48s');
});
