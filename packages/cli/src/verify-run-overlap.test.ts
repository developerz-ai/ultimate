// The ONE scheduling rule the gate has: the static steps run beside the serial suites instead of
// before them (#14). What is pinned is the order a reader sees — unchanged — and the overlap itself.

import { describe, expect, test } from 'bun:test';
import { runVerify } from './verify-run';
import type { VerifyContext, VerifyStep } from './verify-step';
import { VERIFY_STEP_NAMES } from './verify-step';

const runner: VerifyContext['runner'] = async () => ({
  command: ['true'],
  code: 0,
  ok: true,
  stdout: '',
  stderr: '',
  durationMs: 0,
});

/** Every step of the real list, each logging its start and end around a tick. */
function recordingSteps(log: string[]): readonly VerifyStep[] {
  return VERIFY_STEP_NAMES.map((name) => ({
    name,
    summary: name,
    run: async () => {
      log.push(`start ${name}`);
      // A macrotask, so a step that is truly concurrent with another shows up between its edges.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      log.push(`end ${name}`);
      return { ok: true, findings: [] };
    },
  }));
}

describe('unit · the static steps overlap the serial suites', () => {
  test('the table reads in declared order, whatever order the steps finished in', async () => {
    const result = await runVerify(recordingSteps([]), { root: '/nonexistent', runner });
    expect(result.steps?.map((step) => step.name)).toEqual([...VERIFY_STEP_NAMES]);
  });

  test('lint starts after unit and contract, and while live is still running', async () => {
    const log: string[] = [];
    await runVerify(recordingSteps(log), { root: '/nonexistent', runner });

    // Never beside `unit`, which saturates every core, and never beside `typecheck`, which writes.
    expect(log.indexOf('start lint')).toBeGreaterThan(log.indexOf('end contract'));
    expect(log.indexOf('end contract')).toBeGreaterThan(-1);
    // Beside `live`: started before `live` ended.
    expect(log.indexOf('start lint')).toBeLessThan(log.indexOf('end live'));
    expect(log.indexOf('start lint')).toBeGreaterThan(-1);
    // And joined before anything after the serial suites reads the app.
    expect(log.indexOf('end errors')).toBeLessThan(log.indexOf('start drift'));
    expect(log.indexOf('end errors')).toBeGreaterThan(-1);
  });

  test('a one-step run is exactly that step, never the group it belongs to', async () => {
    const log: string[] = [];
    await runVerify(recordingSteps(log), { root: '/nonexistent', runner, only: 'lint' });
    expect(log).toEqual(['start lint', 'end lint']);
  });
});
