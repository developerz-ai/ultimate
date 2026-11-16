// `bun run preflight`: which steps a diff earns, which findings are its own, and the one verdict —
// proved over a throwaway git repository with a recording runner, so no step really runs.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
import type { RunResult } from './lib/run';
import { run } from './lib/run';
import type { StepRunner } from './preflight';
import { preflight, runStep, scriptDocument } from './preflight';
import {
  isOurs,
  movedSource,
  PREFLIGHT_RATCHETS,
  preflightSteps,
  SERVE_GRAPH_TEST,
  touchedUnits,
} from './preflight-plan';

const UNITS = ['cli', 'core', 'create-ultimate', 'scripts'];

describe('the plan', () => {
  test('touchedUnits: a package directory or scripts, never a tracked app or the docs', () => {
    expect(
      touchedUnits(
        [
          'packages/cli/src/a.ts',
          'packages/cli/README.md',
          'packages/create-ultimate/src/b.test.ts',
          'scripts/lib/x.ts',
          'examples/dummy/packages/core/src/c.ts',
          'wiki/Home.md',
        ],
        UNITS,
      ),
    ).toEqual(['cli', 'create-ultimate', 'scripts']);
  });

  test('movedSource: a source file added or gone, never one edited in place or a test', () => {
    const changed = [
      'packages/cli/src/new.ts',
      'packages/cli/src/gone.ts',
      'packages/cli/src/edited.ts',
      'packages/cli/src/gone.test.ts',
    ];
    const exists = (path: string) => !path.includes('gone');
    expect(movedSource(changed, ['packages/cli/src/new.ts'], exists)).toEqual([
      'packages/cli/src/new.ts',
      'packages/cli/src/gone.ts',
    ]);
  });

  test('preflightSteps: every cheap ratchet, coverage per unit, serve-graph only on a move', () => {
    const still = preflightSteps({ touched: ['cli'], moved: [] });
    expect(still.map((step) => step.name)).toEqual([...PREFLIGHT_RATCHETS, 'coverage cli']);
    expect(still.find((step) => step.name === 'coverage cli')?.command).toEqual([
      'bun',
      'run',
      'scripts/coverage-gate.ts',
      '--package',
      'cli',
      '--json',
    ]);
    const moved = preflightSteps({ touched: [], moved: ['packages/cli/src/new.ts'] });
    expect(moved.at(-1)?.command).toEqual(['bun', 'test', SERVE_GRAPH_TEST]);
  });

  test('isOurs: a changed file or a touched unit counts; a teammate’s package does not', () => {
    const at = (where: string) => ({ code: 'X', cause: 'c', fix: 'f', at: where });
    expect(isOurs(at('packages/cli/src/a.ts:3'), ['cli'], [])).toBe(true);
    expect(isOurs(at('packages/cli'), ['cli'], [])).toBe(true);
    expect(isOurs(at('packages/core/src/a.ts:3'), ['cli'], [])).toBe(false);
    expect(isOurs(at('scripts/flake-hunt.ts:76'), ['cli'], [])).toBe(false);
    expect(isOurs(at('wiki/Home.md'), [], ['wiki/Home.md'])).toBe(true);
    expect(isOurs({ code: 'X', cause: 'c', fix: 'f' }, [], [])).toBe(true);
  });
});

const result = (output: string, code = 0): RunResult => ({
  command: [],
  code,
  ok: code === 0,
  output,
  durationMs: 5,
  timedOut: false,
});

describe('a step', () => {
  test('scriptDocument finds the document among stderr noise, and refuses a non-document', () => {
    expect(scriptDocument('warn: x\n{"ok":true,"findings":[]}')).toEqual({
      ok: true,
      findings: [],
    });
    expect(scriptDocument('{"ok":"yes"}')).toBeUndefined();
    expect(scriptDocument('{"ok":tru')).toBeUndefined();
    expect(scriptDocument('nothing')).toBeUndefined();
  });

  test('a red script with no finding, a crash and a red test each still name a finding', async () => {
    const [script] = preflightSteps({ touched: [], moved: [] });
    if (script === undefined) return expect.unreachable('no step planned');
    const quiet = await runStep('/', script, async () => result('{"ok":false,"findings":[]}', 1));
    expect(quiet.findings.map((finding) => finding.code)).toEqual(['X_PREFLIGHT_STEP_FAILED']);
    const crash = await runStep('/', script, async () => result('SyntaxError', 1));
    expect(crash.ok).toBe(false);
    expect(crash.findings[0]?.fix).toBe('bun run scripts/fix-prose.ts');
    const graph = preflightSteps({ touched: [], moved: ['packages/a/src/b.ts'] }).at(-1);
    if (graph === undefined) return expect.unreachable('no serve-graph step planned');
    expect((await runStep('/', graph, async () => result('1 fail', 1))).ok).toBe(false);
    expect((await runStep('/', graph, async () => result('1 pass'))).findings).toEqual([]);
  });
});

const made: string[] = [];
afterAll(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const git = async (cwd: string, ...args: string[]) => {
  const ran = await run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });
  if (!ran.ok) expect.unreachable(`git ${args.join(' ')}: ${ran.output}`);
};

async function repo(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/preflight-`);
  made.push(dir);
  await git(dir, 'init', '-q', '-b', 'work');
  for (const pkg of ['cli', 'core']) await Bun.write(`${dir}/packages/${pkg}/src/a.ts`, '1;\n');
  await Bun.write(`${dir}/CHANGELOG.md`, '# Changelog\n\n## [Unreleased]\n\nNothing yet.\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-q', '-m', 'base');
  await git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return dir;
}

describe('preflight, over a real diff', () => {
  test('runs the steps for the touched unit only, and the verdict is its own findings', async () => {
    const dir = await repo();
    await Bun.write(`${dir}/packages/cli/src/a.ts`, '2;\n');
    const ran: string[] = [];
    const runner: StepRunner = async (command) => {
      ran.push(command.join(' '));
      // A teammate's red in core: printed, never the verdict.
      return command.includes('scripts/fix-prose.ts')
        ? result(
            '{"ok":false,"findings":[{"code":"X_FIX_PROSE","cause":"c","fix":"f","at":"packages/core/src/a.ts:1"}]}',
            1,
          )
        : result('{"ok":true,"findings":[]}');
    };
    const green = await preflight(dir, runner);
    expect(green.touched).toEqual(['cli']);
    expect(ran).toContain('bun run scripts/coverage-gate.ts --package cli --json');
    expect(ran.some((command) => command.includes('--package core'))).toBe(false);
    expect(ran.some((command) => command.includes(SERVE_GRAPH_TEST))).toBe(false);
    expect(green.ok).toBe(true);
    expect(green.elsewhere.map((finding) => finding.code)).toEqual(['X_FIX_PROSE']);
    expect(green.notices.map((finding) => finding.code)).toEqual(['X_CHANGELOG_UNRELEASED_EMPTY']);

    // The same red, now in the unit this diff touched, decides it.
    await Bun.write(`${dir}/packages/core/src/b.ts`, '3;\n');
    const red = await preflight(dir, runner);
    expect(red.ok).toBe(false);
    expect(red.ours.map((finding) => finding.code)).toEqual(['X_FIX_PROSE']);
    expect(ran.some((command) => command.includes(SERVE_GRAPH_TEST))).toBe(true);
  });

  test('paths narrow the diff: a teammate’s unit is neither run nor counted', async () => {
    const dir = await repo();
    await Bun.write(`${dir}/packages/cli/src/a.ts`, '2;\n');
    await Bun.write(`${dir}/packages/core/src/a.ts`, '2;\n');
    const ran: string[] = [];
    const scoped = await preflight(
      dir,
      async (command) => {
        ran.push(command.join(' '));
        return result('{"ok":true,"findings":[]}');
      },
      ['packages/cli/'],
    );
    expect(scoped.touched).toEqual(['cli']);
    expect(ran.some((command) => command.includes('--package core'))).toBe(false);
  });

  test('no origin/main is refused, never read as nothing changed', async () => {
    const dir = await repo();
    await git(dir, 'update-ref', '-d', 'refs/remotes/origin/main');
    const refused = await preflight(dir, async () => expect.unreachable('a step ran'));
    expect(refused.ok).toBe(false);
    expect(refused.ours.map((finding) => finding.code)).toEqual(['X_PREFLIGHT_BASE_MISSING']);
  });
});
