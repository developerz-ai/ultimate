// The loop that follows a gate's own `fix:` lines, proved against a FAKE runner: every assertion
// here is about what the loop does with a table, so nothing is spawned and the scaffold that would
// be needed to spawn it (a `bun install` outside this checkout) is not this file's dependency.
//
// What is NOT proved here: that a real `x new` app reaches green. That needs an installed scaffold
// and belongs to `scaffold-smoke`, which is where `--fix-follow` is meant to be switched on.

import { describe, expect, test } from 'bun:test';
import type { ExecOptions, ExecResult } from '@ultimat3/cli';
import type { Finding } from './lib/log';
import {
  fixFollowFindings,
  followFixes,
  MAX_ROUNDS,
  runnableFix,
  staticBuildFindings,
} from './scaffold-fix-follow';

const DIR = '/tmp/demoapp';

const result = (stdout: string, ok = true): ExecResult => ({
  command: [],
  code: ok ? 0 : 1,
  ok,
  stdout,
  stderr: ok ? '' : 'it failed',
  durationMs: 0,
});

interface Step {
  readonly name: string;
  readonly ok: boolean;
  readonly findings?: readonly Finding[];
}

const table = (steps: readonly Step[]): string =>
  JSON.stringify({
    steps: steps.map((step) => ({
      name: step.name,
      ok: step.ok,
      skipped: false,
      findings: step.findings ?? [],
    })),
  });

const fix = (fixLine: string): Finding => ({ code: 'X_ANY', cause: 'because', fix: fixLine });

/**
 * A gate whose table is whatever the script says next, and which records every argv it was given.
 * `tables` is consumed one entry per `verify`; anything else is a fix line being run.
 */
const fakeRunner = (tables: readonly string[]) => {
  const calls: string[][] = [];
  let next = 0;
  const runner = async (command: readonly string[], _options: ExecOptions): Promise<ExecResult> => {
    calls.push([...command]);
    if (command.includes('verify')) {
      const stdout = tables[Math.min(next, tables.length - 1)] ?? '';
      next += 1;
      return result(stdout);
    }
    return result('');
  };
  return { runner, calls };
};

describe('unit · a fix line is either an argv or an edit', () => {
  test('the three programs a fresh app can run', () => {
    expect(runnableFix('bun run manifest')).toEqual({ argv: ['bun', 'run', 'manifest'] });
    expect(runnableFix('x i18n sync')).toEqual({ argv: ['x', 'i18n', 'sync'] });
    expect(runnableFix('  bunx biome check --write .  ')).toEqual({
      argv: ['bunx', 'biome', 'check', '--write', '.'],
    });
  });

  test('a quoted argument survives, because real fix lines carry one', () => {
    expect(runnableFix("bun test -t 'formats the fix line'")).toEqual({
      argv: ['bun', 'test', '-t', 'formats the fix line'],
    });
  });

  test('an edit is reported, never executed — and the reason names the first word', () => {
    const parsed = runnableFix('delete driver: from jobs in app.config.ts');
    expect('reason' in parsed && parsed.reason).toContain('"delete"');
  });

  test('a shell pipeline is refused: this loop spawns an argv, not a shell', () => {
    for (const line of [
      'bun run manifest && bun run verify',
      'bun x | grep foo',
      'bun -e $(evil)',
    ]) {
      expect('reason' in runnableFix(line)).toBe(true);
    }
  });
});

describe('unit · the loop', () => {
  test('a gate already green runs no fix and reports no round', async () => {
    const { runner, calls } = fakeRunner([table([{ name: 'lint', ok: true }])]);
    const followed = await followFixes(DIR, runner);
    expect(followed.green).toBe(true);
    expect(followed.rounds).toEqual([]);
    expect(calls).toEqual([['bun', 'run', 'verify', '--json']]);
    expect(fixFollowFindings(DIR, followed)).toEqual([]);
  });

  test('red, its fix run verbatim, green on the re-run', async () => {
    const { runner, calls } = fakeRunner([
      table([{ name: 'manifest', ok: false, findings: [fix('bun run manifest')] }]),
      table([{ name: 'manifest', ok: true }]),
    ]);
    const followed = await followFixes(DIR, runner);
    expect(followed.green).toBe(true);
    expect(followed.rounds.map((round) => round.ran)).toEqual([['bun run manifest']]);
    // Verbatim: the argv is the fix line's own words, not a command this loop composed.
    expect(calls[1]).toEqual(['bun', 'run', 'manifest']);
    expect(fixFollowFindings(DIR, followed)).toEqual([]);
  });

  /**
   * THE DEFECT THIS EXISTS FOR: `lint` red, whose `fix:` runs and leaves `lint` red. Every check in
   * this repo passes over that today — the fix line is runnable, it names a command this build
   * ships, and nobody ran it.
   */
  test('a fix that reintroduces its own red is reported after three rounds, not looped on', async () => {
    const red = table([{ name: 'lint', ok: false, findings: [fix('bun run lint:fix')] }]);
    const { runner } = fakeRunner([red, red, red, red]);
    const followed = await followFixes(DIR, runner);
    expect(followed.green).toBe(false);
    expect(followed.rounds).toHaveLength(MAX_ROUNDS);
    // The bound itself, spelled out: `toHaveLength(MAX_ROUNDS)` alone would agree with any value.
    expect(MAX_ROUNDS).toBe(3);
    expect(followed.red).toEqual(['lint']);
    const findings = fixFollowFindings(DIR, followed);
    expect(findings.map((finding) => finding.code)).toEqual(['X_SCAFFOLD_FIX_LOOP']);
    expect(findings[0]?.cause).toContain('round 3');
    expect(findings[0]?.fix).toContain(DIR);
  });

  test('a red step whose fix is an edit stops the loop at once and says which line', async () => {
    const red = table([
      { name: 'errors', ok: false, findings: [fix('delete jobs.driver from app.config.ts')] },
    ]);
    const { runner, calls } = fakeRunner([red, red]);
    const followed = await followFixes(DIR, runner);
    expect(followed.green).toBe(false);
    expect(followed.rounds).toHaveLength(1);
    // One verify, and nothing else: a round that can run nothing must not re-run the gate.
    expect(calls).toEqual([['bun', 'run', 'verify', '--json']]);
    const findings = fixFollowFindings(DIR, followed);
    expect(findings.map((finding) => finding.code)).toEqual(['X_SCAFFOLD_FIX_UNFOLLOWED']);
    expect(findings[0]?.cause).toContain('delete jobs.driver');
  });

  test('a table that cannot be parsed is not green', async () => {
    const { runner } = fakeRunner(['nothing here is json']);
    const followed = await followFixes(DIR, runner);
    expect(followed.green).toBe(false);
    expect(followed.steps).toBeUndefined();
  });
});

describe('unit · the build that must not break lint', () => {
  const script = (built: ExecResult, after: string) => {
    const calls: string[][] = [];
    const runner = async (
      command: readonly string[],
      _options: ExecOptions,
    ): Promise<ExecResult> => {
      calls.push([...command]);
      return command.includes('verify') ? result(after) : built;
    };
    return { runner, calls };
  };

  test('a build that fails is its own finding, and nothing downstream is claimed', async () => {
    const { runner } = script(result('', false), table([{ name: 'lint', ok: true }]));
    const findings = await staticBuildFindings(DIR, runner);
    expect(findings.map((finding) => finding.code)).toEqual(['X_SCAFFOLD_BUILD_FAILED']);
    expect(findings[0]?.fix).toBe(`cd ${DIR} && bun run x build --target static`);
  });

  test('lint red only AFTER the build is the regression, and the command run is the real one', async () => {
    const { runner, calls } = script(result(''), table([{ name: 'lint', ok: false }]));
    const findings = await staticBuildFindings(DIR, runner);
    expect(findings.map((finding) => finding.code)).toEqual(['X_SCAFFOLD_BUILD_REGRESSED']);
    expect(calls[0]).toEqual(['bun', 'run', 'x', 'build', '--target', 'static']);
  });

  test('lint green after the build raises nothing', async () => {
    const { runner } = script(result(''), table([{ name: 'lint', ok: true }]));
    expect(await staticBuildFindings(DIR, runner)).toEqual([]);
  });
});
