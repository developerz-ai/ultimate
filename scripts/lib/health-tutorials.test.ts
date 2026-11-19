// `health-tutorials.ts`: row 10's verdict over each shape the newest tutorial-run.yml run takes,
// and the argv its reader spawns, which the refusal quotes.

import { describe, expect, test } from 'bun:test';
import { judgeTutorialsRun, TUTORIALS_RUN_COMMAND, tutorialsRunReader } from './health-tutorials';
import type { RunResult } from './run';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const run = (fields: Record<string, unknown>) => ({
  runs: [{ databaseId: 7, event: 'push', createdAt: '2026-11-18T12:00:00Z', ...fields }],
});
const verdict = (read: { runs: unknown }) => {
  const answer = judgeTutorialsRun(read, NOW);
  return 'verdict' in answer ? answer.verdict : answer.code;
};

describe('row 10 · the tutorials run as written', () => {
  test('a green newest run is healthy; a failed one is unhealthy and names the guard', () => {
    expect(verdict(run({ conclusion: 'success', status: 'completed' }))).toBe('healthy');
    const red = judgeTutorialsRun(
      run({ conclusion: 'failure', status: 'completed', url: 'u' }),
      NOW,
    );
    expect('verdict' in red && red.verdict).toBe('unhealthy');
    expect('reason' in red && red.reason).toContain('bun run scripts/tutorial-run.ts --json');
    expect('url' in red && red.url).toBe('u');
  });

  test('a run still going, or one a newer push cancelled, is no verdict yet', () => {
    expect(verdict(run({ conclusion: null, status: 'in_progress' }))).toBe('unverdicted');
    expect(verdict(run({ conclusion: 'cancelled', status: 'completed' }))).toBe('unverdicted');
  });

  test('no run at all is no verdict: the weekly schedule makes one', () => {
    expect(verdict({ runs: [] })).toBe('unverdicted');
  });

  test('a newest main run older than the schedule window is stale, not healthy', () => {
    const old = new Date(NOW - 9 * DAY).toISOString();
    const stale = judgeTutorialsRun(run({ conclusion: 'success', createdAt: old }), NOW);
    expect('verdict' in stale && stale.verdict).toBe('unhealthy');
    expect('fix' in stale && stale.fix).toContain('gh workflow run tutorial-run.yml');
    const weekOld = new Date(NOW - 7 * DAY).toISOString();
    expect(verdict(run({ conclusion: 'success', createdAt: weekOld }))).toBe('healthy');
  });

  test('a pull request run is skipped, and a scheduled or dispatched run on main counts', () => {
    const runs = [
      {
        databaseId: 9,
        event: 'pull_request',
        conclusion: 'failure',
        createdAt: '2026-11-19T00:00:00Z',
      },
      {
        databaseId: 8,
        event: 'schedule',
        conclusion: 'success',
        createdAt: '2026-11-18T00:00:00Z',
      },
    ];
    expect(verdict({ runs })).toBe('healthy');
    const dispatched = [{ ...runs[1], event: 'workflow_dispatch', conclusion: 'failure' }];
    expect(verdict({ runs: dispatched })).toBe('unhealthy');
    expect(verdict({ runs: [runs[0]] })).toBe('unverdicted');
  });

  test('an answer that is no run list is unreadable, never a silent healthy', () => {
    expect(verdict({ runs: undefined })).toBe('X_HEALTH_ROW_UNREADABLE');
    expect(verdict({ runs: { message: 'HTTP 502' } })).toBe('X_HEALTH_ROW_UNREADABLE');
  });

  // A pull request runs the workflow too, and its red is that pull request's, never main's — a
  // fork's PR from a branch named `main` included, which `--branch` alone would let through: the
  // judge skips every `pull_request` run it is handed.
  test("the row reads main, never one event alone: a scheduled run is main's too", () => {
    expect(TUTORIALS_RUN_COMMAND).toContain(' --branch main ');
    expect(TUTORIALS_RUN_COMMAND).not.toContain('--event');
  });

  test('the reader asks gh exactly what the row command says', async () => {
    const asked: string[] = [];
    const gh = async (args: readonly string[]): Promise<RunResult> => {
      asked.push(['gh', ...args].join(' '));
      return { command: args, code: 0, ok: true, output: '[]', durationMs: 1, timedOut: false };
    };
    expect(await tutorialsRunReader('.', gh)).toEqual({ runs: [] });
    expect(asked).toEqual([TUTORIALS_RUN_COMMAND]);
  });
});
