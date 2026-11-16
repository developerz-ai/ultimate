// `health-secret.ts`: the private-names secret row — present is healthy, absent is unhealthy with
// the command that sets it, a token that may not list secrets is no verdict (never a green and
// never the whole checkup refused), and junk is unreadable.

import { describe, expect, test } from 'bun:test';
import { judgeSecret, SECRET_COMMAND, SECRET_FIX, secretReader } from './health-secret';
import type { RunResult } from './run';

const answer = (output: string, ok = true): RunResult => ({
  command: [],
  code: ok ? 0 : 1,
  ok,
  output,
  durationMs: 1,
  timedOut: false,
});
const verdict = (read: Parameters<typeof judgeSecret>[0]) => {
  const out = judgeSecret(read);
  return 'verdict' in out ? out.verdict : out.code;
};

describe('row · the private-names secret is set', () => {
  test('listed is healthy; the repositories secret alone is not', () => {
    const both = [{ name: 'ULTIMATE_PRIVATE_NAMES' }, { name: 'ULTIMATE_PRIVATE_REPOS' }];
    expect(verdict({ kind: 'listed', secrets: both })).toBe('healthy');
    const out = judgeSecret({ kind: 'listed', secrets: [{ name: 'ULTIMATE_PRIVATE_REPOS' }] });
    expect(out).toMatchObject({ verdict: 'unhealthy', fix: SECRET_FIX });
    expect(SECRET_FIX).toBe('gh secret set ULTIMATE_PRIVATE_NAMES');
  });

  test('a token that may not list secrets is no verdict, naming the command', () => {
    expect(judgeSecret({ kind: 'forbidden' })).toMatchObject({
      verdict: 'unverdicted',
      fix: SECRET_COMMAND,
    });
  });

  test('anything else is unreadable, never a silent green or red', () => {
    expect(verdict({ kind: 'listed', secrets: { message: 'x' } })).toBe('X_HEALTH_ROW_UNREADABLE');
    expect(verdict({ kind: 'listed', secrets: undefined })).toBe('X_HEALTH_ROW_UNREADABLE');
    expect(verdict({ kind: 'listed', secrets: [{ nope: 1 }] })).toBe('X_HEALTH_ROW_UNREADABLE');
  });

  test('the reader asks gh exactly the row command, and reads a 403 as forbidden', async () => {
    const asked: string[] = [];
    const gh = (output: string, ok: boolean) => async (args: readonly string[]) => {
      asked.push(['gh', ...args].join(' '));
      return answer(output, ok);
    };
    expect(await secretReader('.', gh('[]', true))).toEqual({ kind: 'listed', secrets: [] });
    expect(asked).toEqual([SECRET_COMMAND]);
    const denied = 'failed to get secrets: HTTP 403: Resource not accessible by integration';
    expect(await secretReader('.', gh(denied, false))).toEqual({ kind: 'forbidden' });
    expect(await secretReader('.', gh('HTTP 502', false))).toEqual({
      kind: 'listed',
      secrets: undefined,
    });
  });
});
