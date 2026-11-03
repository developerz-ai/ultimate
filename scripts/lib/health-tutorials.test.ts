// `health-tutorials.ts`: row 10's verdict over each shape the newest tutorial-run.yml run takes,
// and the argv its reader spawns, which the refusal quotes.

import { describe, expect, test } from 'bun:test';
import { judgeTutorialsRun, TUTORIALS_RUN_COMMAND, tutorialsRunReader } from './health-tutorials';
import type { RunResult } from './run';

const run = (fields: Record<string, unknown>) => ({ runs: [{ databaseId: 7, ...fields }] });
const verdict = (read: { runs: unknown }) => {
  const answer = judgeTutorialsRun(read);
  return 'verdict' in answer ? answer.verdict : answer.code;
};

describe('row 10 · the tutorials run as written', () => {
  test('a green newest run is healthy; a failed one is unhealthy and names the guard', () => {
    expect(verdict(run({ conclusion: 'success', status: 'completed' }))).toBe('healthy');
    const red = judgeTutorialsRun(run({ conclusion: 'failure', status: 'completed', url: 'u' }));
    expect('verdict' in red && red.verdict).toBe('unhealthy');
    expect('reason' in red && red.reason).toContain('bun run scripts/tutorial-run.ts --json');
    expect('url' in red && red.url).toBe('u');
  });

  test('a run still going, or one a newer push cancelled, is no verdict yet', () => {
    expect(verdict(run({ conclusion: null, status: 'in_progress' }))).toBe('unverdicted');
    expect(verdict(run({ conclusion: 'cancelled', status: 'completed' }))).toBe('unverdicted');
  });

  test('no run at all is healthy: no push has touched a tutorial or a generator since', () => {
    expect(verdict({ runs: [] })).toBe('healthy');
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
    expect(await tutorialsRunReader('.', gh)).toEqual({ runs: [] });
    expect(asked).toEqual([TUTORIALS_RUN_COMMAND]);
  });
});
