// `x verify --only`'s reader: one step or a comma-separated list, and every refusal before a step
// starts. Split from `cmd-verify.test.ts`, which drives the step engine and is at the line ceiling.

import { describe, expect, test } from 'bun:test';
import { readOnlySteps } from './cmd-verify';
import { msg } from './messages';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import { thrownBy } from './thrown-by';
import { runVerify } from './verify-run';
import type { VerifyContext, VerifyStep } from './verify-step';
import { VERIFY_STEP_NAMES } from './verify-step';

const argsFor = (argv: readonly string[]) => parseArgs(argv, SPECS);

// The whole gate is ~18s, 14s of it `tsc -b`, so the loop this closes is "ask about one step".
describe('unit · --only names a step, and an unknown one is refused before anything runs', () => {
  test('every declared step name reads back as a list of itself', () => {
    for (const name of VERIFY_STEP_NAMES) {
      expect(readOnlySteps(argsFor(['verify', '--only', name]))).toEqual([name]);
    }
    expect(readOnlySteps(argsFor(['verify']))).toBeUndefined();
  });

  test('a near miss leads with the step it is near, and a runnable invocation', () => {
    const failure = thrownBy(() => readOnlySteps(argsFor(['verify', '--only', 'lnt'])));
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.cause).toContain('"lnt" is not a gate step');
    expect(failure.cause).toContain('typecheck, lint');
    expect(failure.fix).toBe('x verify --only lint --json');
  });

  // The house rule for a word near nothing: never an invented lead. The gate itself is the
  // honest fix, and it is a command that runs.
  test('a word near nothing gets the gate, not a guess', () => {
    expect(thrownBy(() => readOnlySteps(argsFor(['verify', '--only', 'zzzzzzzzzz']))).fix).toBe(
      'x verify --json',
    );
  });
});

// An app's scoped runner used to pay one CLI boot and one app load per step: nine processes to
// ask nine read-only questions.
describe('unit · --only takes a comma-separated list', () => {
  test('several steps come back in the GATE order, whatever order they were typed in', () => {
    expect(readOnlySteps(argsFor(['verify', '--only', 'lint,typecheck,boundaries']))).toEqual([
      'typecheck',
      'lint',
      'boundaries',
    ]);
    expect(readOnlySteps(argsFor(['verify', '--only', ' lint , lint ']))).toEqual(['lint']);
  });

  test('an unknown item names every valid step, and the fix corrects only the typo', () => {
    const failure = thrownBy(() => readOnlySteps(argsFor(['verify', '--only', 'typecheck,lnt'])));
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.cause).toContain('"lnt" is not a gate step');
    expect(failure.cause).toContain(VERIFY_STEP_NAMES.join(', '));
    expect(failure.fix).toBe('x verify --only typecheck,lint --json');
  });

  test('several unknown items are all named, and one near nothing falls back to the gate', () => {
    const failure = thrownBy(() => readOnlySteps(argsFor(['verify', '--only', 'lnt,zzzzzzzzzz'])));
    expect(failure.cause).toContain('"lnt", "zzzzzzzzzz" are not gate steps');
    expect(failure.fix).toBe('x verify --json');
  });

  // `''` is not a step, and reading it as "no narrowing" would be a run that checks less than
  // it says. A trailing comma is the realistic way to type one.
  test('an empty item is refused, never read as nothing', () => {
    const failure = thrownBy(() => readOnlySteps(argsFor(['verify', '--only', 'lint,'])));
    expect(failure.cause).toContain('(empty) is not a gate step');
  });

  test('the runner executes exactly the listed steps, once, and still says NOT A GATE RUN', async () => {
    const ran: string[] = [];
    const step = (name: VerifyStep['name']): VerifyStep => ({
      name,
      summary: name,
      run: async () => {
        ran.push(name);
        return { ok: true, findings: [] };
      },
    });
    const ctx: VerifyContext = {
      root: '/nowhere',
      runner: async (command) => ({
        command,
        code: 0,
        ok: true,
        stdout: '',
        stderr: '',
        durationMs: 0,
      }),
      only: ['typecheck', 'boundaries'],
    };
    const result = await runVerify([step('typecheck'), step('lint'), step('boundaries')], ctx);
    expect(ran).toEqual(['typecheck', 'boundaries']);
    expect(result.summary).toContain(msg('cli.verify.notAGateRun', { summary: '' }).trim());
    expect(result.data).toMatchObject({ notAGateRun: true, only: ['typecheck', 'boundaries'] });
  });
});
