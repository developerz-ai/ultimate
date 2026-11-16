// `health-bot-issues.ts`: an open issue the automation filed is stale once its own closer workflow
// has run green since the issue last re-fired — the condition it reports is no longer true. A
// label with no known closer is no verdict naming the table to extend, never a silent pass.

import { describe, expect, test } from 'bun:test';
import {
  BOT_ALARMS,
  BOT_ISSUES_COMMAND,
  botIssuesReader,
  judgeBotIssues,
} from './health-bot-issues';
import type { RunResult } from './run';

const issue = (number: number, label: string, updatedAt: string) => ({
  number,
  title: `t${number}`,
  url: `u${number}`,
  updatedAt,
  labels: [{ name: label }],
});
const green = (createdAt: string) => [{ createdAt, url: 'run' }];
const judge = (issues: unknown, greens: Record<string, unknown> = {}) =>
  judgeBotIssues({ issues, greens: { 'registry-audit.yml': [], 'compat.yml': [], ...greens } });
const verdict = (issues: unknown, greens: Record<string, unknown> = {}) => {
  const out = judge(issues, greens);
  return 'verdict' in out ? out.verdict : out.code;
};

describe('row · no bot issue outlived its condition', () => {
  test('no open bot issue is healthy; one still re-firing is healthy', () => {
    expect(verdict([])).toBe('healthy');
    const firing = [issue(5, 'registry-drift', '2026-11-16T06:20:00Z')];
    expect(verdict(firing, { 'registry-audit.yml': green('2026-11-15T06:17:00Z') })).toBe(
      'healthy',
    );
  });

  test('a green closer run after the last re-fire is stale: unhealthy, names the close', () => {
    const latched = [issue(5, 'registry-drift', '2026-11-14T06:20:00Z')];
    const out = judge(latched, { 'registry-audit.yml': green('2026-11-15T06:17:00Z') });
    expect(out).toMatchObject({ verdict: 'unhealthy', fix: 'gh issue close 5 --reason completed' });
    expect('issues' in out && out.issues?.map((one) => one.number)).toEqual([5]);
  });

  test('a flake-hunt issue is a person to close: a green night is not a fix', () => {
    const flake = [issue(7, 'flake-hunt', '2026-11-01T00:00:00Z')];
    expect(verdict(flake)).toBe('healthy');
    expect(BOT_ALARMS['flake-hunt']).toBeNull();
  });

  test('a bot label with no known closer is no verdict, naming the table to extend', () => {
    const out = judge([issue(8, 'surprise', '2026-11-01T00:00:00Z')]);
    expect(out).toMatchObject({ verdict: 'unverdicted' });
    expect('reason' in out && out.reason).toContain('BOT_ALARMS');
  });

  test('a full page is truncated: no verdict until the limit is raised', () => {
    const page = Array.from({ length: 100 }, (_, at) => issue(at + 1, 'flake-hunt', 'x'));
    expect(verdict(page)).toBe('unverdicted');
  });

  test('junk is unreadable', () => {
    expect(verdict(undefined)).toBe('X_HEALTH_ROW_UNREADABLE');
    expect(verdict([{ title: 'no number' }])).toBe('X_HEALTH_ROW_UNREADABLE');
    expect(verdict([], { 'registry-audit.yml': undefined })).toBe('X_HEALTH_ROW_UNREADABLE');
  });

  test('the reader asks gh exactly the row command; an absent closer workflow has no runs', async () => {
    const asked: string[] = [];
    const gh = async (args: readonly string[]): Promise<RunResult> => {
      asked.push(['gh', ...args].join(' '));
      const missing = args.includes('compat.yml');
      const output = missing
        ? 'HTTP 404: workflow compat.yml not found on the default branch'
        : '[]';
      return {
        command: args,
        code: missing ? 1 : 0,
        ok: !missing,
        output,
        durationMs: 1,
        timedOut: false,
      };
    };
    const read = await botIssuesReader('.', gh);
    expect(asked.join('; ')).toBe(BOT_ISSUES_COMMAND);
    expect(read.greens['compat.yml']).toEqual([]);
    expect(judgeBotIssues(read)).toMatchObject({ verdict: 'healthy' });
  });
});
