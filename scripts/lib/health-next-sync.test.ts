// `health-next-sync.ts`: the next-sync row's verdict over each shape the newest next-sync.yml run
// takes — green, red, still going, stopped being scheduled, never run — and the argv its reader
// spawns, which the refusal quotes.

import { describe, expect, test } from 'bun:test';
import { judgeNextSync, NEXT_SYNC_COMMAND, nextSyncReader } from './health-next-sync';
import type { RunResult } from './run';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const run = (fields: Record<string, unknown>) => ({
  runs: [{ databaseId: 7, createdAt: '2026-11-23T04:41:00Z', ...fields }],
});
const verdict = (read: { runs: unknown }) => {
  const answer = judgeNextSync(read, NOW);
  return 'verdict' in answer ? answer.verdict : answer.code;
};

describe('row next-sync · next still holds everything main has', () => {
  test('a green week is healthy; a red one is unhealthy and names the open issue', () => {
    expect(verdict(run({ conclusion: 'success', status: 'completed' }))).toBe('healthy');
    const red = judgeNextSync(run({ conclusion: 'failure', url: 'u' }), NOW);
    expect('verdict' in red && red.verdict).toBe('unhealthy');
    expect('fix' in red && red.fix).toContain('next-sync: main is not merged into next');
    expect('url' in red && red.url).toBe('u');
    expect('row' in red && red.row).toBe('next-sync');
  });

  test('a run still going, or cancelled, is no verdict yet', () => {
    expect(verdict(run({ conclusion: null, status: 'in_progress' }))).toBe('unverdicted');
    expect(verdict(run({ conclusion: 'cancelled', status: 'completed' }))).toBe('unverdicted');
  });

  test('a newest run older than eight days is unhealthy: the weekly schedule stopped', () => {
    const stale = judgeNextSync(
      run({ conclusion: 'success', createdAt: '2026-11-15T11:59:59Z' }),
      NOW,
    );
    expect('verdict' in stale && stale.verdict).toBe('unhealthy');
    expect('fix' in stale && stale.fix).toContain('gh workflow run next-sync.yml');
    expect(verdict(run({ conclusion: 'success', createdAt: '2026-11-15T12:00:01Z' }))).toBe(
      'healthy',
    );
  });

  test('no run yet is no verdict, and an unreadable answer is never a silent healthy', () => {
    expect(verdict({ runs: [] })).toBe('unverdicted');
    expect(verdict({ runs: { message: 'HTTP 502' } })).toBe('X_HEALTH_ROW_UNREADABLE');
  });

  test('the reader asks gh exactly what the row command says', async () => {
    const asked: string[] = [];
    const gh = async (args: readonly string[]): Promise<RunResult> => {
      asked.push(['gh', ...args].join(' '));
      return { command: args, code: 0, ok: true, output: '[]', durationMs: 1, timedOut: false };
    };
    expect(await nextSyncReader('.', gh)).toEqual({ runs: [] });
    expect(asked).toEqual([NEXT_SYNC_COMMAND]);
    expect(NEXT_SYNC_COMMAND).toContain('--workflow next-sync.yml');
  });
});
