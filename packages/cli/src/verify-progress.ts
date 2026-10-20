// What the gate writes to stderr WHILE it runs, in every render mode: a line per finished step and
// a heartbeat naming the steps still running. Both entries print their verdict only at the end, so
// a run killed mid-way left nothing (#589), and a harness that kills on SILENCE killed a healthy one.

import type { Clock } from '@ultimat3/core';
import { systemClock } from '@ultimat3/core';
import { msg } from './messages';
import type { StepResult } from './output';
import type { VerifyStepName } from './verify-step';

/**
 * How often the heartbeat names the steps still running. Bounded by the silence budget of the
 * harness that runs the gate, not by cost: an agent runner or CI job that kills a process after
 * 30 minutes with no new output byte killed green gates that finished seconds past it, and one
 * step on a slow 2-core box can outlast that window on its own, so a line per finished step is
 * not enough. A minute is far inside any silence window a harness sets.
 */
export const HEARTBEAT_MS = 60_000;

/** A repeating timer that returns its own stop — injected so a test advances time, never sleeps. */
export type Every = (tick: () => void, intervalMs: number) => () => void;

/** Unref'd: a heartbeat must never be the thing that keeps a finished gate's process alive. */
const unrefInterval: Every = (tick, intervalMs) => {
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
};

/** `{"step":"lint","ok":true,"ms":21987}` — plus `"skipped":true` for a step that did not apply. */
export const stepLine = (step: StepResult): string =>
  JSON.stringify({
    step: step.name,
    ok: step.ok,
    ms: step.durationMs,
    ...(step.skipped === true ? { skipped: true } : {}),
  });

/** `12m 3s`, `45s`: a person reading a CI log, not a parser — the step lines carry exact ms. */
export const elapsedLabel = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds % 60}s`;
};

/** `still running: unit (12m 3s), live (4m 0s)` — each step with the time since IT started. */
export const heartbeatLine = (running: ReadonlyMap<string, number>, now: number): string =>
  msg('cli.verify.stillRunning', {
    steps: [...running].map(([name, began]) => `${name} (${elapsedLabel(now - began)})`).join(', '),
  });

/** The two `VerifyContext` listeners a progress run hands the gate. */
export interface VerifyProgressHooks {
  readonly onStepStart: (name: VerifyStepName) => void;
  readonly onStep: (step: StepResult) => void;
}

export interface VerifyProgressOptions {
  readonly clock?: Clock;
  readonly every?: Every;
}

/**
 * Run the gate with progress on `write` (stderr), the heartbeat stopped however `run` ends. One
 * function for both entries (`x verify`, and `bun run verify` at the framework root), so the two
 * cannot print different lines; stdout is untouched, so `--json` stays one document there.
 */
export async function withVerifyProgress<T>(
  write: (line: string) => void,
  run: (hooks: VerifyProgressHooks) => Promise<T>,
  options: VerifyProgressOptions = {},
): Promise<T> {
  const clock = options.clock ?? systemClock;
  const running = new Map<string, number>();
  const stop = (options.every ?? unrefInterval)(() => {
    if (running.size === 0) return;
    // Inside a timer callback a throw is an uncaught exception: stderr closed under the gate must
    // not take the run down with it. The verdict still reaches stdout.
    try {
      write(heartbeatLine(running, clock.monotonic()));
    } catch {
      // Nowhere left to say it.
    }
  }, HEARTBEAT_MS);
  try {
    return await run({
      onStepStart: (name) => {
        running.set(name, clock.monotonic());
      },
      onStep: (step) => {
        running.delete(step.name);
        write(stepLine(step));
      },
    });
  } finally {
    stop();
  }
}
