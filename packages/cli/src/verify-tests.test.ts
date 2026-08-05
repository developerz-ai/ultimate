import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VerifyContext } from './verify-step';
import { TEST_STEPS, TEST_TYPES, testStepCommand } from './verify-tests';

const REPO_ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');

const ctxFor = (root: string): VerifyContext => ({
  root,
  runner: async () => ({
    command: ['bun', 'test'],
    code: 0,
    ok: true,
    stdout: '',
    stderr: '',
    durationMs: 0,
  }),
});

describe('unit · one bun test invocation per test type', () => {
  test('every test type is a step, in cost order', () => {
    expect(TEST_STEPS.map((step) => step.name)).toEqual([...TEST_TYPES]);
  });

  test('unit claims everything the typed suites do not', () => {
    const command = testStepCommand('unit').join(' ');
    expect(command).toContain('--path-ignore-patterns=**/*.{contract,live,job,e2e,eval}.test.*');
    expect(command).toContain('--path-ignore-patterns=**/e2e/**');
    expect(command).toContain('--path-ignore-patterns=**/dist/**');
  });

  test('a typed step selects its suffix and nothing else', () => {
    expect(testStepCommand('contract')).toEqual([
      'bun',
      'test',
      '--path-ignore-patterns=**/dist/**',
      '--path-ignore-patterns=**/build/**',
      '--path-ignore-patterns=**/examples/**',
      '.contract.test.',
    ]);
    expect(testStepCommand('job').at(-1)).toBe('.job.test.');
    expect(testStepCommand('e2e').at(-1)).toBe('e2e');
  });

  // A nested project with its own `x verify` is gated once, by its own run. Collecting it here
  // too would report the app's failures on the framework's gate and the app's gate both.
  test('every type skips nested projects that carry their own gate', () => {
    for (const type of TEST_TYPES) {
      expect(testStepCommand(type)).toContain('--path-ignore-patterns=**/examples/**');
    }
  });

  test('a failed step tells you the exact command that reproduces it', async () => {
    const step = TEST_STEPS.find((entry) => entry.name === 'job');
    const outcome = await step?.run({
      ...ctxFor(REPO_ROOT),
      runner: async (command) => ({
        command,
        code: 1,
        ok: false,
        stdout: '',
        stderr: 'boom',
        durationMs: 1,
      }),
    });
    expect(outcome?.ok).toBe(false);
    expect(outcome?.findings[0]?.code).toBe('X_TEST_FAILED');
    expect(outcome?.findings[0]?.fix).toBe(testStepCommand('job').join(' '));
  });

  test('a type with no suites here is skipped, never silently passed', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'ultimate-verify-tests-'));
    try {
      await Bun.write(join(empty, 'packages/core/src/core.test.ts'), 'export {};\n');
      const applies = async (name: string, root: string): Promise<boolean | undefined> =>
        TEST_STEPS.find((step) => step.name === name)?.applies?.(ctxFor(root));
      expect(await applies('contract', empty)).toBe(false);
      expect(await applies('e2e', empty)).toBe(false);
      expect(await applies('e2e', REPO_ROOT)).toBe(true);
      expect(TEST_STEPS.find((step) => step.name === 'unit')?.applies).toBeUndefined();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  // `applies` and the command must read the same exclusions. When they disagreed, a suite that
  // lived only under an ignored path made its step apply and then fail on "no test files matched".
  test('a suite that only exists in an ignored path does not make its step apply', async () => {
    const nested = await mkdtemp(join(tmpdir(), 'ultimate-verify-nested-'));
    try {
      await Bun.write(join(nested, 'examples/dummy/app/posts.contract.test.ts'), 'export {};\n');
      await Bun.write(join(nested, 'packages/cli/dist/bundled.e2e.test.ts'), 'export {};\n');
      const applies = async (name: string): Promise<boolean | undefined> =>
        TEST_STEPS.find((step) => step.name === name)?.applies?.(ctxFor(nested));
      expect(await applies('contract')).toBe(false);
      expect(await applies('e2e')).toBe(false);
    } finally {
      await rm(nested, { recursive: true, force: true });
    }
  });
});
