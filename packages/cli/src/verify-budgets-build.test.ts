// The budgets step builds first when the stats on disk cannot be read as this tree's. A recording
// runner stands in for `x build`: it writes the stats a real build would, so each case asserts
// what was spawned and what reached the step.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory, recursive-remove or set-mtime native; each case is a fresh tree.
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { BUILD_STATS_FILE, BUILD_STATS_RULES } from './budgets';
import type { ExecResult, Runner } from './exec';
import { measureIfStale, VERIFY_STATIC_OUT, verifyBuildCommand } from './verify-budgets-build';
import { VERIFY_STEPS } from './verify-checks';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SOURCE = join('apps', 'web', 'site', 'page.tsx');

const OTHER = join('apps', 'web', 'site', 'about', 'page.tsx');
/** The directories a source file sits in: their mtimes count too (a deleted page moves only them). */
const SOURCE_DIRS = [
  join('apps', 'web', 'site', 'about'),
  join('apps', 'web', 'site'),
  join('apps', 'web'),
  'apps',
];

/** An app tree with two source files, every file and directory at `sourceAt` seconds. */
const appTree = async (sourceAt: number): Promise<string> => {
  const root = mkdtempSync(join(tmpdir(), 'verify-budgets-build-'));
  dirs.push(root);
  mkdirSync(join(root, 'apps', 'web', 'site', 'about'), { recursive: true });
  await Bun.write(join(root, SOURCE), 'export const Page = () => null;\n');
  await Bun.write(join(root, OTHER), 'export const Page = () => null;\n');
  for (const path of [SOURCE, OTHER, ...SOURCE_DIRS])
    utimesSync(join(root, path), sourceAt, sourceAt);
  return root;
};

const writeStats = async (root: string, at: number, measuredBy = BUILD_STATS_RULES) => {
  const path = join(root, BUILD_STATS_FILE);
  await Bun.write(path, JSON.stringify({ routes: [], measuredBy }));
  utimesSync(path, at, at);
};

const result = (command: readonly string[], code: number, stdout: string): ExecResult => ({
  command,
  code,
  ok: code === 0,
  stdout,
  stderr: '',
  durationMs: 1,
});

/** A runner that records every argv and answers as a build would: stats written, or a failure. */
const recording = (root: string, answer: 'writes' | 'fails' | 'garbles') => {
  const calls: { command: readonly string[]; cwd: string }[] = [];
  const runner: Runner = async (command, options) => {
    calls.push({ command, cwd: options.cwd });
    if (answer === 'writes') {
      await writeStats(root, 2_000_000_000);
      return result(command, 0, JSON.stringify({ ok: true, command: 'build', summary: 'built' }));
    }
    if (answer === 'garbles') return result(command, 1, 'Segmentation fault\n');
    const document = {
      ok: false,
      command: 'build',
      summary: 'static build failed',
      findings: [
        {
          code: 'X_BUILD_FAILED',
          cause: 'bun run apps/web/prerender.ts exited 1',
          fix: 'x verify --json',
          docs: 'https://example.invalid',
        },
      ],
      data: { output: 'UltimateError: X_PRERENDER_FAILED: a prerendered path threw' },
    };
    return result(command, 1, JSON.stringify(document));
  };
  return { calls, runner };
};

describe('unit · the budgets step measures first when the stats are unusable', () => {
  test('no stats spawns exactly one static build, into .x/verify-static, from the root', async () => {
    const root = await appTree(1_000_000_000);
    const { calls, runner } = recording(root, 'writes');
    const outcome = await measureIfStale({ root, runner });
    expect(calls).toEqual([{ command: verifyBuildCommand(), cwd: root }]);
    // The CLI's own entry is spawned (`x build`, the one builder), so the argv ends with its words.
    expect(calls[0]?.command.slice(-7)).toEqual([
      'build',
      '--target',
      'static',
      '--no-preflight',
      '--out',
      VERIFY_STATIC_OUT,
      '--json',
    ]);
    expect(calls[0]?.command[0]).toBe(process.execPath);
    expect(VERIFY_STATIC_OUT).toBe(join('.x', 'verify-static'));
    expect(outcome).toMatchObject({ state: 'missing', built: true, findings: [] });
    expect(outcome.output).toContain('missing');
  });

  test('fresh stats spawn nothing and say nothing', async () => {
    const root = await appTree(1_000_000_000);
    await writeStats(root, 1_500_000_000);
    const { calls, runner } = recording(root, 'writes');
    const outcome = await measureIfStale({ root, runner });
    expect(calls).toEqual([]);
    expect(outcome).toEqual({ state: 'fresh', built: false, findings: [] });
  });

  test('a source newer than the stats rebuilds', async () => {
    const root = await appTree(1_600_000_000);
    await writeStats(root, 1_500_000_000);
    const { calls, runner } = recording(root, 'writes');
    const outcome = await measureIfStale({ root, runner });
    expect(calls.length).toBe(1);
    expect(outcome).toMatchObject({ state: 'older-than-source', built: true, findings: [] });
  });

  test('stats of an earlier measurement rule rebuild', async () => {
    const root = await appTree(1_000_000_000);
    await writeStats(root, 1_500_000_000, BUILD_STATS_RULES - 1);
    const { calls, runner } = recording(root, 'writes');
    expect((await measureIfStale({ root, runner })).state).toBe('old-rule');
    expect(calls.length).toBe(1);
  });

  test('a test file edited after the build does not rebuild: it ships no bytes', async () => {
    const root = await appTree(1_000_000_000);
    await writeStats(root, 1_500_000_000);
    const test = join(root, 'apps', 'web', 'site', 'page.test.tsx');
    await Bun.write(test, 'export {};\n');
    // An EDIT: the file existed before the build, so its directory kept the build's clock.
    utimesSync(join(root, SOURCE_DIRS[1] ?? ''), 1_000_000_000, 1_000_000_000);
    utimesSync(test, 1_600_000_000, 1_600_000_000);
    const { calls, runner } = recording(root, 'writes');
    expect((await measureIfStale({ root, runner })).state).toBe('fresh');
    expect(calls).toEqual([]);
  });

  // Deleting a page changes no remaining file's mtime; it moves its directory's. Without the
  // directories the old stats read fresh and weighed a route that no longer exists.
  test('a deleted page rebuilds: its parent directory moved, though no remaining file did', async () => {
    const root = await appTree(1_000_000_000);
    await writeStats(root, 1_500_000_000);
    // The page's directory goes with it, which moves its parent — the clock pinned for the test.
    rmSync(join(root, SOURCE_DIRS[0] ?? ''), { recursive: true });
    utimesSync(join(root, SOURCE_DIRS[1] ?? ''), 1_600_000_000, 1_600_000_000);
    const { calls, runner } = recording(root, 'writes');
    expect((await measureIfStale({ root, runner })).state).toBe('older-than-source');
    expect(calls.length).toBe(1);
  });

  test("a failing build's own findings reach the step unchanged, with its output", async () => {
    const root = await appTree(1_000_000_000);
    const { runner } = recording(root, 'fails');
    const outcome = await measureIfStale({ root, runner });
    expect(outcome.built).toBe(true);
    expect(outcome.findings).toEqual([
      {
        code: 'X_BUILD_FAILED',
        cause: 'bun run apps/web/prerender.ts exited 1',
        fix: 'x verify --json',
        docs: 'https://example.invalid',
      },
    ]);
    expect(outcome.output).toContain('X_PRERENDER_FAILED');
  });

  test('a build that printed no document is still red, with what it printed', async () => {
    const root = await appTree(1_000_000_000);
    const { runner } = recording(root, 'garbles');
    const outcome = await measureIfStale({ root, runner });
    expect(outcome.findings.map((finding) => finding.code)).toEqual(['X_BUILD_FAILED']);
    expect(outcome.findings[0]?.fix).toBe('x build --target static --json');
    expect(outcome.output).toContain('Segmentation fault');
  });
});

describe('unit · x verify`s budgets step builds before it weighs', () => {
  test('the step itself spawns the build on a fresh tree, and a failed build is its verdict', async () => {
    const root = await appTree(1_000_000_000);
    await Bun.write(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fresh', version: '1.0.0' }),
    );
    await Bun.write(join(root, 'app.config.ts'), "export const config = { name: 'fresh' };\n");
    const { calls, runner } = recording(root, 'fails');
    const step = VERIFY_STEPS.find((candidate) => candidate.name === 'budgets');
    const outcome = await step?.run({ root, runner });
    expect(calls.map((call) => call.command)).toEqual([verifyBuildCommand()]);
    expect(outcome?.ok).toBe(false);
    expect(outcome?.findings.map((finding) => finding.code)).toEqual(['X_BUILD_FAILED']);
    expect(outcome?.output).toContain('built first');
  });
});
