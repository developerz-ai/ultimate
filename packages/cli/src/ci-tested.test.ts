// `x ci tested`'s predicate over scripted GitHub reads: every condition, false alone, answers
// `tested: false` and names itself; every doubt (a fork, a stale run, a moved tree, an API that
// did not answer) widens the gate. The `gh` argv and the command's render: `cmd-ci-tested.test.ts`.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import type { CiTestedReads, TestedCommit, TestedPull, TestedRun } from './ci-tested';
import {
  ciTested,
  ghTestedReads,
  mergedPullOf,
  TESTED_CALL_TIMEOUT_MS,
  TESTED_CONDITIONS,
  withDeadline,
} from './ci-tested';
import type { GhHost } from './gh';

const SHA = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const REPO = 'developerz-ai/ultimate';
const NOW = Date.parse('2026-11-03T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

class ReadRefused extends UltimateError {
  constructor() {
    super({ code: 'X_GH_COMMAND_FAILED', cause: 'HTTP 502', fix: 'x ci tested --json' });
  }
}

interface World {
  readonly commits: Readonly<Record<string, TestedCommit>>;
  readonly pull: TestedPull;
  readonly runs: readonly TestedRun[];
}

const green: World = {
  commits: {
    [SHA]: { subject: 'feat: a change (#972)', tree: TREE },
    [HEAD]: { subject: 'feat: a change', tree: TREE },
  },
  pull: { merged: true, mergeCommitSha: SHA, headSha: HEAD, headRepo: REPO },
  runs: [
    {
      id: 41,
      status: 'completed',
      conclusion: 'success',
      headRepo: REPO,
      completedAt: '2026-11-03T11:00:00Z',
    },
  ],
};

const readsOf = (world: World, broken?: keyof CiTestedReads): CiTestedReads => ({
  commit: async (sha) => {
    if (broken === 'commit') throw new ReadRefused();
    const found = world.commits[sha];
    if (found === undefined) expect.unreachable(`no commit ${sha}`);
    return found;
  },
  pull: async (number) => {
    if (broken === 'pull') throw new ReadRefused();
    expect(number).toBe(972);
    return world.pull;
  },
  runs: async (headSha) => {
    if (broken === 'runs') throw new ReadRefused();
    expect(headSha).toBe(HEAD);
    return world.runs;
  },
});

const ask = (world: World, broken?: keyof CiTestedReads) =>
  ciTested({ sha: SHA, repo: REPO, maxAgeMs: DAY, now: NOW, reads: readsOf(world, broken) });

const withRun = (over: Partial<TestedRun>): World => ({
  ...green,
  runs: [{ ...(green.runs[0] as TestedRun), ...over }],
});

describe('unit · x ci tested · a push whose tree a green PR run already tested', () => {
  test('every condition holds: tested, with the PR and the run that proved it', async () => {
    expect(await ask(green)).toEqual({ tested: true, condition: 'tested', pr: 972, run: 41 });
  });

  test('a subject with no (#N) is no merge of a pull request', async () => {
    const world = {
      ...green,
      commits: { ...green.commits, [SHA]: { subject: 'fix: pushed by hand', tree: TREE } },
    };
    expect(await ask(world)).toEqual({ tested: false, condition: 'subject' });
  });

  test('(#N) mid-subject is not the merge suffix', async () => {
    expect(mergedPullOf('revert (#12) and more')).toBeUndefined();
    expect(mergedPullOf('feat: x (#12)')).toBe(12);
    expect(mergedPullOf('feat: x (#12)\n\nbody')).toBeUndefined();
  });

  test('PR N not merged, or merged as another commit, is a doubt', async () => {
    const unmerged = { ...green, pull: { ...green.pull, merged: false } };
    const other = { ...green, pull: { ...green.pull, mergeCommitSha: 'd'.repeat(40) } };
    expect(await ask(unmerged)).toEqual({ tested: false, condition: 'merged', pr: 972 });
    expect(await ask(other)).toEqual({ tested: false, condition: 'merged', pr: 972 });
  });

  test('a fork head is never admitted, nor a head whose repository is gone', async () => {
    const fork = { ...green, pull: { ...green.pull, headRepo: 'someone/ultimate' } };
    const gone = { ...green, pull: { ...green.pull, headRepo: null } };
    expect(await ask(fork)).toEqual({ tested: false, condition: 'fork', pr: 972 });
    expect(await ask(gone)).toEqual({ tested: false, condition: 'fork', pr: 972 });
  });

  test('a tree that moved since the head the PR run tested', async () => {
    const moved = {
      ...green,
      commits: { ...green.commits, [HEAD]: { subject: 'feat: a change', tree: 'e'.repeat(40) } },
    };
    expect(await ask(moved)).toEqual({ tested: false, condition: 'tree', pr: 972 });
  });

  test('no green run on the head: none, red, unfinished, or a fork run', async () => {
    for (const world of [{ ...green, runs: [] }, withRun({ headRepo: 'someone/ultimate' })]) {
      expect(await ask(world)).toEqual({ tested: false, condition: 'run', pr: 972 });
    }
    for (const world of [
      withRun({ conclusion: 'failure' }),
      withRun({ status: 'in_progress', conclusion: null }),
    ]) {
      expect(await ask(world)).toEqual({ tested: false, condition: 'run', pr: 972, run: 41 });
    }
  });

  test('the newest run on the head decides: a later red run vetoes an earlier green one', async () => {
    const vetoed = {
      ...green,
      runs: [
        ...green.runs,
        { ...(green.runs[0] as TestedRun), id: 42, conclusion: 'failure' as const },
      ],
    };
    expect(await ask(vetoed)).toEqual({ tested: false, condition: 'run', pr: 972, run: 42 });
  });

  test('a run older than --max-age is stale: the runner image and the registry moved', async () => {
    const stale = withRun({ completedAt: '2026-11-02T11:59:59Z' });
    const unread = withRun({ completedAt: 'yesterday' });
    expect(await ask(stale)).toEqual({ tested: false, condition: 'stale', pr: 972, run: 41 });
    expect(await ask(unread)).toEqual({ tested: false, condition: 'stale', pr: 972, run: 41 });
  });

  test('an API failure at any read widens the gate, with the read named', async () => {
    for (const broken of ['commit', 'pull', 'runs'] as const) {
      const answer = await ask(green, broken);
      expect(answer.tested).toBe(false);
      expect(answer.condition).toBe('api');
      expect(answer.detail).toContain('X_GH_COMMAND_FAILED');
    }
  });

  test('the conditions are a closed list, each one a reason the command can render', () => {
    expect([...TESTED_CONDITIONS]).toEqual([
      'tested',
      'subject',
      'merged',
      'fork',
      'tree',
      'run',
      'stale',
      'api',
      'sha',
    ]);
  });
});

describe('unit · x ci tested · a gh call that never answers', () => {
  // A stalled `gh api` held the job to its `timeout-minutes`, a red `tested` rather than the
  // `tested: false` every other doubt gets. Each call is killed past its own deadline.
  test('is killed past its deadline and answered as an api doubt, never awaited forever', async () => {
    const killed: number[] = [];
    const stalled: GhHost = {
      cwd: '/repo',
      runner: (_command, options) => {
        options.onSpawn?.(4242);
        return new Promise<never>(() => undefined);
      },
    };
    const host = withDeadline(stalled, 5, (pid) => killed.push(pid));
    const repo = { owner: 'developerz-ai', name: 'ultimate', slug: REPO };
    const answer = await ciTested({
      sha: SHA,
      repo: REPO,
      maxAgeMs: DAY,
      now: NOW,
      reads: ghTestedReads(host, repo, 'ci.yml'),
    });
    expect(answer).toMatchObject({ tested: false, condition: 'api' });
    expect(answer.detail).toContain('did not answer within 5 ms');
    expect(killed).toEqual([4242]);
  });

  test('an answer inside the deadline passes through, and nothing is killed', async () => {
    const killed: number[] = [];
    const quick: GhHost = {
      cwd: '/repo',
      runner: async (command) => ({
        command,
        code: 0,
        ok: true,
        stdout: 'ok',
        stderr: '',
        durationMs: 1,
      }),
    };
    const result = await withDeadline(quick, 1_000, (pid) => killed.push(pid)).runner(['gh'], {
      cwd: '/repo',
    });
    expect(result.stdout).toBe('ok');
    expect(killed).toEqual([]);
    expect(TESTED_CALL_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});
