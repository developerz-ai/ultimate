// `health-bench.ts`: the bench row's verdict over each shape the newest weekly bench.yml run takes —
// green, red, still going, stopped being scheduled, never run — and the argv its reader spawns,
// which the refusal quotes.

import { describe, expect, test } from 'bun:test';
import { BENCH_COMMAND, benchReader, judgeBench } from './health-bench';
import type { RunResult } from './run';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const run = (fields: Record<string, unknown>) => ({
  runs: [{ databaseId: 9, createdAt: '2026-11-16T04:41:00Z', ...fields }],
});
const verdict = (read: { runs: unknown }) => {
  const answer = judgeBench(read, NOW);
  return 'verdict' in answer ? answer.verdict : answer.code;
};

describe('row · the weekly bench ran green', () => {
  test('a green week is healthy; a red one is unhealthy, names the run and its fix', () => {
    expect(verdict(run({ conclusion: 'success', status: 'completed' }))).toBe('healthy');
    const red = judgeBench(run({ conclusion: 'failure', status: 'completed', url: 'u' }), NOW);
    expect('verdict' in red && red.verdict).toBe('unhealthy');
    expect('fix' in red && red.fix).toBe('gh run view 9 --log-failed');
    expect('url' in red && red.url).toBe('u');
  });

  test('a run still going, or cancelled, is no verdict yet', () => {
    expect(verdict(run({ conclusion: null, status: 'in_progress' }))).toBe('unverdicted');
    expect(verdict(run({ conclusion: 'cancelled', status: 'completed' }))).toBe('unverdicted');
  });

  test('a newest run older than eight days is unhealthy: the weekly schedule stopped', () => {
    const stale = run({ conclusion: 'success', createdAt: '2026-11-08T11:59:59Z' });
    expect(verdict(stale)).toBe('unhealthy');
    expect(judgeBench(stale, NOW)).toMatchObject({
      fix: 'gh workflow enable bench.yml && gh workflow run bench.yml --ref main',
    });
    const fresh = run({ conclusion: 'success', createdAt: '2026-11-08T12:00:01Z' });
    expect(verdict(fresh)).toBe('healthy');
  });

  test('no run yet is no verdict, never a silent green', () => {
    expect(verdict({ runs: [] })).toBe('unverdicted');
  });

  test('an answer that is no run list is unreadable', () => {
    expect(verdict({ runs: undefined })).toBe('X_HEALTH_ROW_UNREADABLE');
    expect(verdict({ runs: { message: 'HTTP 502' } })).toBe('X_HEALTH_ROW_UNREADABLE');
    expect(verdict({ runs: [{ databaseId: 1 }] })).toBe('X_HEALTH_ROW_UNREADABLE');
  });

  test('the reader asks gh exactly what the row command says', async () => {
    const asked: string[] = [];
    const gh = async (args: readonly string[]): Promise<RunResult> => {
      asked.push(['gh', ...args].join(' '));
      return { command: args, code: 0, ok: true, output: '[]', durationMs: 1, timedOut: false };
    };
    expect(await benchReader('.', gh)).toEqual({ runs: [] });
    expect(asked).toEqual([BENCH_COMMAND]);
    expect(BENCH_COMMAND).toBe(
      'gh run list --workflow bench.yml --limit 1 --json databaseId,event,status,conclusion,headBranch,headSha,displayTitle,url,createdAt',
    );
  });
});
