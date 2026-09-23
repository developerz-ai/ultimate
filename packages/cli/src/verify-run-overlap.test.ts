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

  test('manifest runs beside live too: it reads committed files and writes none', async () => {
    const log: string[] = [];
    await runVerify(recordingSteps(log), { root: '/nonexistent', runner });
    expect(log.indexOf('start manifest')).toBeGreaterThan(-1);
    expect(log.indexOf('start manifest')).toBeLessThan(log.indexOf('end live'));
    expect(log.indexOf('start manifest')).toBeGreaterThan(log.indexOf('end contract'));
    expect(log.indexOf('end contract')).toBeGreaterThan(-1);
    expect(log.indexOf('end manifest')).toBeLessThan(log.indexOf('start drift'));
    expect(log.indexOf('end manifest')).toBeGreaterThan(-1);
  });

  test('a one-step run is exactly that step, never the group it belongs to', async () => {
    const log: string[] = [];
    await runVerify(recordingSteps(log), { root: '/nonexistent', runner, only: 'lint' });
    expect(log).toEqual(['start lint', 'end lint']);
  });
});

// Row n: a throwing `applies` escaped `runStep`'s catch and took the whole gate down with it.
describe('unit · a step whose applies() throws fails that step, and the gate runs on', () => {
  test("the throw is the step's finding, and the next step still runs", async () => {
    const ran: string[] = [];
    const steps: readonly VerifyStep[] = [
      {
        name: 'lint',
        summary: 'lint',
        applies: async () => {
          throw new TypeError('config unreadable');
        },
        run: async () => ({ ok: true, findings: [] }),
      },
      {
        name: 'boundaries',
        summary: 'boundaries',
        run: async () => {
          ran.push('boundaries');
          return { ok: true, findings: [] };
        },
      },
    ];
    const result = await runVerify(steps, { root: '/nonexistent', runner });
    expect(result.steps?.map((step) => [step.name, step.ok])).toEqual([
      ['lint', false],
      ['boundaries', true],
    ]);
    expect(result.steps?.[0]?.findings[0]?.code).toBe('X_VERIFY_FAILED');
    expect(ran).toEqual(['boundaries']);
  });
});
