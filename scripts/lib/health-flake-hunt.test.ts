// `health-flake-hunt.ts`: row 11's verdict over each shape the newest flake-hunt.yml run takes —
// green, red, still going, stopped being scheduled, never run — and the argv its reader spawns,
// which the refusal quotes.

import { describe, expect, test } from 'bun:test';
import { FLAKE_HUNT_COMMAND, flakeHuntReader, judgeFlakeHunt } from './health-flake-hunt';
import type { RunResult } from './run';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const run = (fields: Record<string, unknown>) => ({
  runs: [{ databaseId: 7, createdAt: '2026-11-15T02:23:00Z', ...fields }],
});
const verdict = (read: { runs: unknown }) => {
  const answer = judgeFlakeHunt(read, NOW);
  return 'verdict' in answer ? answer.verdict : answer.code;
};

describe('row 11 · the weekly flake hunt is green', () => {
  test('a green night is healthy; a red one is unhealthy and names the issues', () => {
    expect(verdict(run({ conclusion: 'success', status: 'completed' }))).toBe('healthy');
    const red = judgeFlakeHunt(run({ conclusion: 'failure', status: 'completed', url: 'u' }), NOW);
    expect('verdict' in red && red.verdict).toBe('unhealthy');
    expect('reason' in red && red.reason).toContain('gh issue list --label flake-hunt');
    expect('url' in red && red.url).toBe('u');
  });

  test('a red night carries the commit it ran at, as the brief says row 11 does', () => {
    const red = judgeFlakeHunt(run({ conclusion: 'failure', headSha: 'abc123' }), NOW);
    expect('headSha' in red && red.headSha).toBe('abc123');
    expect(FLAKE_HUNT_COMMAND).toContain('headSha');
  });

  test('a night still running, or cancelled, is no verdict yet', () => {
    expect(verdict(run({ conclusion: null, status: 'in_progress' }))).toBe('unverdicted');
    expect(verdict(run({ conclusion: 'cancelled', status: 'completed' }))).toBe('unverdicted');
  });

  test('a newest run older than eight days is unhealthy: the schedule stopped', () => {
    const stale = run({ conclusion: 'success', createdAt: '2026-11-07T02:23:00Z' });
    expect(verdict(stale)).toBe('unhealthy');
    const fresh = run({ conclusion: 'success', createdAt: '2026-11-07T12:00:01Z' });
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
    expect(await flakeHuntReader('.', gh)).toEqual({ runs: [] });
    expect(asked).toEqual([FLAKE_HUNT_COMMAND]);
  });
});
