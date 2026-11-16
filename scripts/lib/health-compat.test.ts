// `health-compat.ts`: the compat row's verdict over each shape the newest compat.yml run takes —
// green, red, still going, stopped being scheduled, never run — and the argv its reader spawns,
// which the refusal quotes.

import { describe, expect, test } from 'bun:test';
import { COMPAT_COMMAND, compatReader, judgeCompat } from './health-compat';
import type { RunResult } from './run';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const run = (fields: Record<string, unknown>) => ({
  runs: [{ databaseId: 7, createdAt: '2026-11-21T03:41:00Z', ...fields }],
});
const verdict = (read: { runs: unknown }) => {
  const answer = judgeCompat(read, NOW);
  return 'verdict' in answer ? answer.verdict : answer.code;
};

describe('row compat · the weekly compat matrix is green', () => {
  test('a green week is healthy; a red one is unhealthy and names the open cells', () => {
    expect(verdict(run({ conclusion: 'success', status: 'completed' }))).toBe('healthy');
    const red = judgeCompat(run({ conclusion: 'failure', headSha: 'abc', url: 'u' }), NOW);
    expect('verdict' in red && red.verdict).toBe('unhealthy');
    expect('reason' in red && red.reason).toContain('gh issue list --label compat --state open');
    expect('url' in red && red.url).toBe('u');
    expect('headSha' in red && red.headSha).toBe('abc');
    expect('row' in red && red.row).toBe('compat');
  });

  test('a run still going, or cancelled, is no verdict yet', () => {
    expect(verdict(run({ conclusion: null, status: 'in_progress' }))).toBe('unverdicted');
    expect(verdict(run({ conclusion: 'cancelled', status: 'completed' }))).toBe('unverdicted');
  });

  test('a newest run older than eight days is unhealthy: the weekly schedule stopped', () => {
    const stale = run({ conclusion: 'success', createdAt: '2026-11-13T11:59:59Z' });
    expect(verdict(stale)).toBe('unhealthy');
    const fresh = run({ conclusion: 'success', createdAt: '2026-11-13T12:00:01Z' });
    expect(verdict(fresh)).toBe('healthy');
  });

  test('no run yet is no verdict: the first week has not come', () => {
    expect(verdict({ runs: [] })).toBe('unverdicted');
  });

  test('an answer that is no run list is unreadable, never a silent healthy', () => {
    expect(verdict({ runs: undefined })).toBe('X_HEALTH_ROW_UNREADABLE');
    expect(verdict({ runs: { message: 'HTTP 502' } })).toBe('X_HEALTH_ROW_UNREADABLE');
  });

  test('the reader asks gh exactly what the row command says', async () => {
    const asked: string[] = [];
    const gh = async (args: readonly string[]): Promise<RunResult> => {
      asked.push(['gh', ...args].join(' '));
      return { command: args, code: 0, ok: true, output: '[]', durationMs: 1, timedOut: false };
    };
    expect(await compatReader('.', gh)).toEqual({ runs: [] });
    expect(asked).toEqual([COMPAT_COMMAND]);
    expect(COMPAT_COMMAND).toContain('--workflow compat.yml');
  });
});
