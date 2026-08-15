// The defect this file pins cannot be written as an ordinary test: it only exists ACROSS test
// files in one process (`bun test packages/query packages/cli` failed five tests in `query`, all
// of them installed by `cli`; either package alone was green). So the boundary arithmetic is
// tested directly, and the cross-file half is tested by running a real `bun test` over two fixture
// files in a child process and reading what it reports.

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  leakBetween,
  RegistryLeakError,
  type RegistrySample,
  sampleRegistries,
} from './registry-leak-guard';

const sample = (tags: readonly string[], tiers: readonly string[]): RegistrySample => ({
  tags,
  tiers,
});

describe('leakBetween', () => {
  test('reports the tags a file declared and did not put back', () => {
    expect(leakBetween('a.test.ts', sample([], []), sample(['devfixture'], []))).toEqual({
      file: 'a.test.ts',
      tags: ['devfixture'],
      tiers: [],
    });
  });

  test('reports a tier the file registered and left', () => {
    expect(leakBetween('a.test.ts', sample([], []), sample([], ['lru']))).toEqual({
      file: 'a.test.ts',
      tags: [],
      tiers: ['lru'],
    });
  });

  test('nothing added is nothing to report', () => {
    expect(leakBetween('a.test.ts', sample(['post'], ['lru']), sample(['post'], ['lru']))).toBe(
      undefined,
    );
  });

  // The legitimate pattern: install in `beforeAll`, tear down in `afterAll`. The file ends where
  // it started, so a guard that compared "is it empty?" instead of "what did you add?" would fail
  // every suite that shares a process with an app's own boot.
  test('a file that put back what it took is clean, even when the process is not empty', () => {
    expect(
      leakBetween('a.test.ts', sample(['app'], ['redis']), sample(['app'], ['redis'])),
    ).toBeUndefined();
  });

  test('a file that DROPPED something is not this bug, and is not reported here', () => {
    expect(leakBetween('a.test.ts', sample(['post'], []), sample([], []))).toBeUndefined();
  });
});

describe('sampleRegistries', () => {
  test('reads the live registries, so the guard cannot drift from what it guards', () => {
    const now = sampleRegistries();
    expect(Array.isArray(now.tags)).toBe(true);
    expect(Array.isArray(now.tiers)).toBe(true);
  });
});

describe('RegistryLeakError', () => {
  test('names the file, what it left, and the calls that put it back', () => {
    const error = new RegistryLeakError({
      leaks: [{ file: 'packages/cli/src/cmd-dev.test.ts', tags: ['devfixture'], tiers: ['lru'] }],
    });

    expect(error.code).toBe('X_TEST_REGISTRY_LEAK');
    expect(error.cause).toContain('packages/cli/src/cmd-dev.test.ts');
    expect(error.cause).toContain('devfixture');
    expect(error.cause).toContain('lru');
    expect(error.fix).toContain('isolateDeclaredTags()');
    expect(error.fix).toContain('resetTiers');
    expect(error.fix).toContain('packages/cli/src/cmd-dev.test.ts');
  });

  test('one error carries every leaker, because the run ends once', () => {
    const error = new RegistryLeakError({
      leaks: [
        { file: 'a.test.ts', tags: ['one'], tiers: [] },
        { file: 'b.test.ts', tags: ['two'], tiers: [] },
      ],
    });

    expect(error.cause).toContain('a.test.ts');
    expect(error.cause).toContain('b.test.ts');
  });
});

const SRC = import.meta.dir;
const PRELOAD = join(SRC, 'preload.ts');
const CACHE = join(SRC, '..', '..', 'cache', 'src', 'index.ts');

/** Absolute specifiers: the fixture lives in a temp dir with no `node_modules` to resolve through. */
const LEAKY = `import { expect, test } from 'bun:test';
import { declareTags } from '${CACHE}';

test('declares a fixture entity and never puts it back', () => {
  declareTags(['leakyfixture']);
  expect(1).toBe(1);
});
`;

const CLEAN = `import { expect, test } from 'bun:test';

test('touches no registry', () => {
  expect(1).toBe(1);
});
`;

describe('the guard, across files, in one process', () => {
  test('a run whose files all pass still fails, naming the file that leaked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'x-leak-guard-'));
    try {
      await Bun.write(join(dir, 'leaky.test.ts'), LEAKY);
      await Bun.write(join(dir, 'clean.test.ts'), CLEAN);

      const run = Bun.spawnSync({
        cmd: ['bun', 'test', '--preload', PRELOAD, '.'],
        cwd: dir,
        env: { ...process.env, ULTIMATE_TEST_ALLOW_NET: '1' },
      });
      const output = `${run.stdout.toString()}${run.stderr.toString()}`;

      // Both tests pass — which is the point: nothing in either file is wrong on its own, and
      // before the guard this run was green while the next package's suite paid for it.
      expect(output).toContain('2 pass');
      expect(run.exitCode).not.toBe(0);
      expect(output).toContain('X_TEST_REGISTRY_LEAK');
      expect(output).toContain('leaky.test.ts');
      expect(output).toContain('leakyfixture');
      // Attribution is the whole asset: the clean file must not be named.
      expect(output).not.toContain('clean.test.ts left');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
