// `x verify --changed` over the suites: a test step runs the test files the diff's import closure
// reaches (`ctx.tests`), never the whole type — and an empty selection spawns nothing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive: `mkdtemp`/`rm` build and remove the throwaway tree.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { ExecOptions, ExecResult } from './exec';
import type { VerifyContext, VerifyStep, VerifyStepName } from './verify-step';
import { resetTestDiscovery, TEST_STEPS } from './verify-tests';

let root = '';
const calls: (readonly string[])[] = [];

const runner = async (command: readonly string[], _options?: ExecOptions): Promise<ExecResult> => {
  calls.push(command);
  return { command, ok: true, code: 0, stdout: '', stderr: '', durationMs: 1 };
};

const step = (name: string): VerifyStep => {
  const found = TEST_STEPS.find((candidate) => candidate.name === name);
  if (found === undefined) return expect.unreachable(`no ${name} step`);
  return found;
};

/** `tests` reached by the diff; the graph read every listed file plus `known`. */
const ctx = (
  tests: readonly string[],
  options: { readonly known?: readonly string[]; readonly whole?: readonly VerifyStepName[] } = {},
): VerifyContext => ({
  root,
  runner,
  workers: 2,
  tests: {
    scope: {
      app: root,
      known: options.known ?? [
        'pkg/a.test.ts',
        'pkg/b.test.ts',
        'pkg/x.live.test.ts',
        'pkg/y.live.test.ts',
      ],
      changed: 1,
      tests,
      all: false,
      forcing: [],
    },
    whole: options.whole ?? [],
  },
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-verify-tests-changed-'));
  for (const path of [
    'pkg/a.test.ts',
    'pkg/b.test.ts',
    'pkg/x.live.test.ts',
    'pkg/y.live.test.ts',
  ]) {
    await Bun.write(join(root, path), '// t\n');
  }
  resetTestDiscovery();
});

afterAll(async () => {
  resetTestDiscovery();
  await rm(root, { recursive: true, force: true });
});

describe('unit · --changed narrows each suite to the tests the diff reaches', () => {
  test('unit runs the selected file and not its sibling', async () => {
    calls.length = 0;
    await step('unit').run(ctx(['pkg/a.test.ts']));
    const argv = calls.flat().join(' ');
    expect(argv).toContain('pkg/a.test.ts');
    expect(argv).not.toContain('pkg/b.test.ts');
  });

  test('a serial suite runs one process over the selected files only', async () => {
    calls.length = 0;
    await step('live').run(ctx(['pkg/x.live.test.ts']));
    expect(calls).toHaveLength(1);
    const argv = (calls[0] ?? []).join(' ');
    expect(argv).toContain('pkg/x.live.test.ts');
    expect(argv).not.toContain('pkg/y.live.test.ts');
  });

  test('a suite the selection does not reach spawns nothing and claims no tests ran', async () => {
    calls.length = 0;
    const outcome = await step('live').run(ctx(['pkg/a.test.ts']));
    expect(calls).toHaveLength(0);
    expect(outcome.ok).toBe(true);
    expect(outcome.tests).toBeUndefined();
  });
});

describe('unit · what --changed never narrows away', () => {
  test('a test the graph never read runs beside the selection (x test --affected keeps it too)', async () => {
    calls.length = 0;
    await step('unit').run(ctx(['pkg/a.test.ts'], { known: ['pkg/a.test.ts'] }));
    const argv = calls.flat().join(' ');
    expect(argv).toContain('pkg/a.test.ts');
    expect(argv).toContain('pkg/b.test.ts');
  });

  test('a suite a doc selected runs whole', async () => {
    calls.length = 0;
    await step('unit').run(ctx([], { whole: ['unit'] }));
    const argv = calls.flat().join(' ');
    expect(argv).toContain('pkg/a.test.ts');
    expect(argv).toContain('pkg/b.test.ts');
  });
});
