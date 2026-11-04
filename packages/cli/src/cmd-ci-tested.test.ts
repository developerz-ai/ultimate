// `x ci tested` end to end over a scripted `gh`: the argv it sends, the sha it asks about, the
// answer it renders, and that EVERY answer exits 0 — a doubt is `tested: false`, never a red job.
// The predicate's own conditions: `ci-tested.test.ts`.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { REQUIRED_BUN } from './app-root';
import { CI_TESTED_MESSAGE_KEYS, ciCommand } from './cmd-ci';
import type { CommandContext } from './command';
import type { ExecResult, Runner } from './exec';
import { messageKeys } from './messages';
import { parseArgs } from './parse';

/** What a runner raises for a program it cannot spawn — `gh` not installed. */
class SpawnRefused extends UltimateError {
  constructor() {
    super({ code: 'X_CLI_UNEXPECTED', cause: 'ENOENT: gh', fix: 'gh auth login' });
  }
}

const SHA = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const NOW = new Date().toISOString();

const commit = (subject: string): string => JSON.stringify({ subject, tree: TREE });
const pull = JSON.stringify({
  merged: true,
  mergeCommitSha: SHA,
  headSha: HEAD,
  headRepo: 'developerz-ai/ultimate',
});
const runsAt = (completedAt: string): string =>
  JSON.stringify([
    {
      id: 41,
      status: 'completed',
      conclusion: 'success',
      headRepo: 'developerz-ai/ultimate',
      completedAt,
    },
  ]);

function ghTable(answer: (joined: string) => ExecResult['stdout'] | Error): {
  runner: Runner;
  ran: string[][];
} {
  const ran: string[][] = [];
  const runner: Runner = async (command): Promise<ExecResult> => {
    ran.push([...command]);
    const stdout = answer(command.join(' '));
    if (stdout instanceof Error) {
      return { command, code: 1, ok: false, stdout: '', stderr: 'HTTP 502', durationMs: 1 };
    }
    return { command, code: 0, ok: true, stdout, stderr: '', durationMs: 1 };
  };
  return { runner, ran };
}

const world =
  (subject: string, broken?: string, completedAt = NOW) =>
  (joined: string): string | Error => {
    if (broken !== undefined && joined.includes(broken)) return new Error(broken);
    if (joined.startsWith('git rev-parse HEAD')) return `${SHA}\n`;
    if (joined.startsWith('gh repo view')) return '{"nameWithOwner":"developerz-ai/ultimate"}';
    if (joined.includes(`/commits/${SHA}`)) return commit(subject);
    if (joined.includes(`/commits/${HEAD}`)) return commit('the head');
    if (joined.includes('/pulls/972')) return pull;
    if (joined.includes('/runs')) return runsAt(completedAt);
    expect.unreachable(`no reply for: ${joined}`);
  };

const contextFor = (
  argv: readonly string[],
  runner: Runner,
  env: Readonly<Record<string, string>> = {},
): CommandContext => ({
  args: parseArgs(argv, [ciCommand.spec]),
  cwd: '/repo',
  runner,
  env,
  bunVersion: REQUIRED_BUN,
});

interface TestedData {
  readonly sha: string;
  readonly tested: boolean;
  readonly condition: string;
  readonly reason: string;
  readonly pr?: number;
  readonly run?: number;
}

describe('unit · x ci tested', () => {
  test('the declared reason keys are in the catalog', () => {
    const known = new Set(messageKeys());
    for (const key of CI_TESTED_MESSAGE_KEYS) expect([key, known.has(key)]).toEqual([key, true]);
  });

  test('a bare x ci is still the triage: runs is the default subcommand', () => {
    expect(parseArgs(['ci'], [ciCommand.spec]).subcommand).toBe('runs');
    expect(parseArgs(['ci', 'tested'], [ciCommand.spec]).subcommand).toBe('tested');
    // A triage flag on `tested` is refused by the parser, never accepted and ignored.
    expect(() => parseArgs(['ci', 'tested', '--branch', 'main'], [ciCommand.spec])).toThrow();
    expect(() => parseArgs(['ci', '--max-age', '1h'], [ciCommand.spec])).toThrow();
  });

  test('GITHUB_SHA is the commit asked about, and the argv is the three reads', async () => {
    const { runner, ran } = ghTable(world('feat: a change (#972)'));
    const argv = ['ci', 'tested', '--repo', 'developerz-ai/ultimate', '--json'];
    const result = await ciCommand.run(contextFor(argv, runner, { GITHUB_SHA: SHA }));
    const data = result.data as unknown as TestedData;
    expect(result.ok).toBe(true);
    expect(data).toMatchObject({ sha: SHA, tested: true, condition: 'tested', pr: 972, run: 41 });
    expect(data.reason).toContain('#972');
    expect(ran.map((argvOf) => argvOf.slice(0, 2).concat(argvOf[2] ?? []))).toEqual([
      ['gh', 'api', `repos/developerz-ai/ultimate/commits/${SHA}`],
      ['gh', 'api', 'repos/developerz-ai/ultimate/pulls/972'],
      ['gh', 'api', `repos/developerz-ai/ultimate/commits/${HEAD}`],
      ['gh', 'api', '-X'],
    ]);
    expect(ran[3]).toContain('repos/developerz-ai/ultimate/actions/workflows/ci.yml/runs');
    expect(ran[3]).toContain(`head_sha=${HEAD}`);
  });

  test('with no GITHUB_SHA, HEAD; with no --repo, the checkout own remote', async () => {
    const { runner, ran } = ghTable(world('fix: by hand'));
    const result = await ciCommand.run(contextFor(['ci', 'tested'], runner));
    expect(ran.slice(0, 2)).toEqual([
      ['gh', 'repo', 'view', '--json', 'nameWithOwner'],
      ['git', 'rev-parse', 'HEAD'],
    ]);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ sha: SHA, tested: false, condition: 'subject' });
  });

  test('an API failure is a doubt: tested false, exit 0, the reason printed', async () => {
    const { runner } = ghTable(world('feat: a change (#972)', '/pulls/'));
    const result = await ciCommand.run(
      contextFor(['ci', 'tested', '--repo', 'developerz-ai/ultimate'], runner, { GITHUB_SHA: SHA }),
    );
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBeUndefined();
    expect(result.data).toMatchObject({ tested: false, condition: 'api', pr: 972 });
    expect(result.summary).toContain('X_GH_COMMAND_FAILED');
  });

  test('gh absent, or no remote to resolve, is a doubt too', async () => {
    const runner: Runner = async () => {
      throw new SpawnRefused();
    };
    const result = await ciCommand.run(contextFor(['ci', 'tested'], runner));
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ tested: false, condition: 'api' });
  });

  test('--max-age is read as a duration, and an unreadable one is refused before any read', async () => {
    const { runner, ran } = ghTable(world('feat: a change (#972)'));
    const argv = ['ci', 'tested', '--max-age', 'soon', '--repo', 'developerz-ai/ultimate'];
    const error = await ciCommand.run(contextFor(argv, runner)).then(
      () => ({}) as { code?: string },
      (thrown: unknown) => thrown as { code?: string },
    );
    expect(error.code).toBe('X_CLI_BAD_FLAG');
    expect(ran).toEqual([]);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const conditionAt = async (maxAge: string): Promise<string> => {
      const table = ghTable(world('feat: a change (#972)', undefined, twoHoursAgo));
      const argvOf = ['ci', 'tested', '--max-age', maxAge, '--repo', 'developerz-ai/ultimate'];
      const result = await ciCommand.run(contextFor(argvOf, table.runner, { GITHUB_SHA: SHA }));
      return (result.data as unknown as TestedData).condition;
    };
    expect(await conditionAt('1h')).toBe('stale');
    expect(await conditionAt('3h')).toBe('tested');
  });
});
