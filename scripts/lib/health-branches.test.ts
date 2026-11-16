// `health-branches.ts`: a `dz/*` branch with no open pull request is stale once its pull request
// merged or closed, or once its tip idled past a week with none; the row lists them and names the
// delete, never deleting. A truncated page is no verdict.

import { describe, expect, test } from 'bun:test';
import { BRANCHES_COMMAND, branchesReader, judgeBranches } from './health-branches';
import type { RunResult } from './run';
import { repoRoot } from './run';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const node = (
  name: string,
  committedDate: string,
  prs: { number: number; state: string }[] = [],
) => ({
  name,
  target: { committedDate },
  associatedPullRequests: { nodes: prs },
});
const doc = (nodes: unknown[], totalCount = nodes.length) => ({
  data: { repository: { refs: { totalCount, nodes } } },
});
const verdict = (value: unknown) => {
  const out = judgeBranches({ refs: value }, NOW);
  return 'verdict' in out ? out.verdict : out.code;
};

describe('row · no merged or abandoned dz/* branch lingers', () => {
  test('none, an open PR, or a fresh PR-less branch is healthy', () => {
    expect(verdict(doc([]))).toBe('healthy');
    const open = node('a', '2026-01-01T00:00:00Z', [{ number: 1, state: 'OPEN' }]);
    expect(verdict(doc([open]))).toBe('healthy');
    expect(verdict(doc([node('b', '2026-11-09T12:00:01Z')]))).toBe('healthy');
  });

  test('merged or closed, at any age, and PR-less past a week are stale and listed', () => {
    const merged = node('m', '2026-11-16T00:00:00Z', [{ number: 2, state: 'MERGED' }]);
    const closed = node('c', '2026-11-16T00:00:00Z', [{ number: 3, state: 'CLOSED' }]);
    const idle = node('i', '2026-11-09T11:59:59Z');
    const out = judgeBranches({ refs: doc([merged, closed, idle]) }, NOW);
    expect(out).toMatchObject({
      verdict: 'unhealthy',
      fix: 'git push origin --delete dz/m dz/c dz/i',
    });
    expect('branches' in out && out.branches?.map((one) => one.name)).toEqual([
      'dz/m',
      'dz/c',
      'dz/i',
    ]);
    expect('branches' in out && out.branches?.[0]?.pr).toEqual({ number: 2, state: 'MERGED' });
  });

  test('a page short of the total is no verdict', () => {
    expect(verdict(doc([node('b', '2026-11-16T00:00:00Z')], 101))).toBe('unverdicted');
  });

  test('junk is unreadable, never a silent green', () => {
    expect(verdict(undefined)).toBe('X_HEALTH_ROW_UNREADABLE');
    expect(verdict({ errors: [{ message: 'Bad credentials' }] })).toBe('X_HEALTH_ROW_UNREADABLE');
    expect(verdict(doc([{ name: 'x' }]))).toBe('X_HEALTH_ROW_UNREADABLE');
  });

  test('the reader asks gh exactly the row command', async () => {
    const asked: string[] = [];
    const gh = async (args: readonly string[]): Promise<RunResult> => {
      asked.push(['gh', ...args].join(' '));
      return { command: args, code: 0, ok: true, output: '{}', durationMs: 1, timedOut: false };
    };
    await branchesReader('.', gh);
    expect(asked.join('; ')).toBe(BRANCHES_COMMAND);
  });

  test('the query file the command names exists and asks for every field the judge reads', async () => {
    const path = BRANCHES_COMMAND.split('@')[1] ?? '';
    const query = await Bun.file(`${repoRoot()}/${path}`).text();
    for (const field of ['refs/heads/dz/', 'totalCount', 'committedDate', 'number', 'state']) {
      expect(query).toContain(field);
    }
  });
});
