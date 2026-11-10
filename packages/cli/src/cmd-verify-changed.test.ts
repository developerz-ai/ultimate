// `x verify --changed`: the flags it reads, what it refuses before git runs, and the run it narrows
// to — the steps the diff's files select, announced as NOT A GATE RUN with `data.changed`.

import { describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import type { Runner } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import { thrownBy } from './thrown-by-fixture';
import { changedScope, readChangedRun, withChangedData } from './verify-changed-scope';

const argsFor = (argv: readonly string[]) => parseArgs(argv, SPECS);

/** A git that answers a fixed checkout root and diff, and records what it was asked. */
const git = (root: string, diff: readonly string[]): { runner: Runner; calls: string[] } => {
  const calls: string[] = [];
  const runner: Runner = async (argv) => {
    calls.push(argv.join(' '));
    // A clone: `origin/HEAD` points at `origin/main`, which is what an unflagged run diffs against.
    const stdout = argv.includes('--show-toplevel')
      ? `${root}\n`
      : argv[1] === 'symbolic-ref'
        ? 'origin/main\n'
        : argv[1] === 'diff'
          ? diff.map((path) => `${path}\0`).join('')
          : 'abc\n';
    return { ok: true, code: 0, stdout, stderr: '', command: [...argv], durationMs: 1 };
  };
  return { runner, calls };
};

/** An `appTestScope` answer: the graph read every test named here, and these were reached. */
const scopeOf = (tests: readonly string[], known: readonly string[] = tests, app = '/app') => ({
  app,
  known: [...known, 'apps/web/x.live.test.ts'],
  changed: 1,
  tests,
  all: false,
  forcing: [],
});

const noFacts = async () => ({ driftReach: new Set<string>(), known: new Set<string>() });

describe('unit · --changed is read, and refused beside another narrowing', () => {
  test('no --changed reads nothing', () => {
    expect(readChangedRun(argsFor(['verify']), undefined)).toBe(false);
    expect(readChangedRun(argsFor(['verify', '--changed']), undefined)).toBe(true);
  });

  test('--changed with --only is two narrowings, refused with the run that works', () => {
    const failure = thrownBy(() =>
      readChangedRun(argsFor(['verify', '--changed', '--only', 'lint']), ['lint']),
    );
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.fix).toBe('x verify --changed --json');
  });

  test('--base or --dirty without --changed narrows nothing, and is refused', () => {
    for (const argv of [
      ['verify', '--base', 'main'],
      ['verify', '--dirty'],
    ]) {
      const failure = thrownBy(() => readChangedRun(argsFor(argv), undefined));
      expect(failure.code).toBe('X_CLI_BAD_FLAG');
      expect(failure.fix).toContain('x verify --changed');
    }
  });
});

describe('unit · a stray --base is handed back screened', () => {
  // The fix is pasted into a shell: a ref is the caller's text, and `main;id` must stay one word.
  test('a hostile ref never reaches the fix; a plain one is handed back as typed', () => {
    const hostile = thrownBy(() =>
      readChangedRun(argsFor(['verify', '--base', 'main;id']), undefined),
    );
    expect(hostile.fix).toBe('x verify --changed --base <ref> --json');
    const plain = thrownBy(() =>
      readChangedRun(argsFor(['verify', '--base', 'origin/next']), undefined),
    );
    expect(plain.fix).toBe('x verify --changed --base origin/next --json');
    const dirty = thrownBy(() => readChangedRun(argsFor(['verify', '--dirty']), undefined));
    expect(dirty.fix).toBe('x verify --changed --dirty --json');
  });
});

describe('unit · the diff picks the steps', () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-changed-'));

  test('a docs-only diff selects the doc steps, each naming the file', async () => {
    const { runner, calls } = git(root, ['docs/a.md']);
    const scope = await changedScope({
      runner,
      root,
      args: argsFor(['verify', '--changed']),
      facts: noFacts,
    });
    expect(scope.plan.steps.map((step) => step.name)).toEqual([
      'package-shape',
      'errors',
      'unit',
      'manifest',
      'roadmap',
    ]);
    // The remote-tracking default branch, never local `main`: a checkout nobody pulls has a stale
    // one, and the diff would count what origin already merged as this branch's work.
    expect(calls).toContain('git diff --name-only -z origin/main...HEAD');
    expect(scope.selection.base).toBe('origin/main');
  });

  test('--base and --dirty reach git exactly as x affected sends them', async () => {
    const { runner, calls } = git(root, []);
    await changedScope({
      runner,
      root,
      args: argsFor(['verify', '--changed', '--base', 'next', '--dirty']),
      facts: noFacts,
    });
    expect(calls).toContain('git diff --name-only -z next...HEAD');
    expect(calls).toContain('git diff --name-only -z HEAD');
    // An explicit --base asks git nothing about the default.
    expect(calls.some((call) => call.includes('symbolic-ref'))).toBe(false);
  });

  test('an app below the checkout root sees a file outside it as outside, and runs everything', async () => {
    const { runner } = git(join(root, '..'), ['other/thing.ts']);
    const scope = await changedScope({
      runner,
      root,
      args: argsFor(['verify', '--changed']),
      facts: noFacts,
    });
    expect(scope.plan.files[0]?.rule).toBe('outside');
    rmSync(root, { recursive: true, force: true });
  });

  test('the result carries data.changed beside what the run already reported', () => {
    const result = withChangedData(
      { ok: true, command: 'verify', summary: 's', data: { notAGateRun: true } },
      {
        selection: { base: 'main', dirty: false },
        plan: {
          files: [{ path: 'docs/a.md', rule: 'doc' }],
          steps: [{ name: 'unit', files: ['docs/a.md'] }],
        },
        tests: { scope: scopeOf(['docs/a.test.ts']), whole: [], kept: ['docs/a.test.ts'] },
        forcing: [],
      },
    );
    expect(result.data).toEqual({
      notAGateRun: true,
      changed: {
        base: 'main',
        dirty: false,
        files: [{ path: 'docs/a.md', rule: 'doc' }],
        steps: [{ name: 'unit', files: ['docs/a.md'] }],
        tests: { all: false, files: ['docs/a.test.ts'], whole: [] },
      },
    });
    expect(result.lines?.some((line) => line.includes('unit') && line.includes('docs/a.md'))).toBe(
      true,
    );
  });
});

describe('unit · the suites run the tests the diff reaches', () => {
  test('a selection drops the suites it does not reach and rides on the scope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-changed-tests-'));
    const { runner } = git(root, ['apps/web/site/page.tsx']);
    const scope = await changedScope({
      runner,
      root,
      args: argsFor(['verify', '--changed']),
      facts: async () => ({ driftReach: new Set(), known: new Set(['apps/web/site/page.tsx']) }),
      tests: async () => scopeOf(['apps/web/site/page.test.ts'], undefined, root),
      discover: async () => ['apps/web/site/page.test.ts', 'apps/web/x.live.test.ts'],
    });
    rmSync(root, { recursive: true, force: true });
    expect(scope.tests?.scope.tests).toEqual(['apps/web/site/page.test.ts']);
    const names = scope.plan.steps.map((step) => step.name);
    expect(names).toContain('unit');
    expect(names).not.toContain('live');
  });

  test('a changed file that forced every test keeps every suite', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-changed-tests-'));
    const { runner } = git(root, ['apps/web/site/page.tsx']);
    const scope = await changedScope({
      runner,
      root,
      args: argsFor(['verify', '--changed']),
      facts: async () => ({ driftReach: new Set(), known: new Set(['apps/web/site/page.tsx']) }),
      tests: async () => ({ ...scopeOf([]), all: true, forcing: ['bunfig.toml'] }),
      discover: async () => [],
    });
    rmSync(root, { recursive: true, force: true });
    expect(scope.tests).toBeUndefined();
    expect(scope.plan.steps.map((step) => step.name)).toContain('live');
  });
});

describe('unit · a test the module graph never read is kept, never dropped', () => {
  test('bin/setup.test.ts, the only unit test and unmapped, keeps the unit step', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-changed-unmapped-'));
    const { runner } = git(root, ['apps/web/site/page.tsx']);
    const scope = await changedScope({
      runner,
      root,
      args: argsFor(['verify', '--changed']),
      facts: async () => ({ driftReach: new Set(), known: new Set(['apps/web/site/page.tsx']) }),
      tests: async () => scopeOf([], [], root),
      discover: async () => ['bin/setup.test.ts'],
    });
    rmSync(root, { recursive: true, force: true });
    expect(scope.plan.steps.map((step) => step.name)).toContain('unit');
    expect(scope.tests?.kept).toEqual(['bin/setup.test.ts']);
  });
});
