// `health-docs-origin.ts`: the docs-site origin row over the two reads it makes — the repository
// variable the deploy is gated on, and the Pages site that serves it — each defect named with the
// command that repairs it, and no host spelled in this file: the fixtures use a reserved name.

import { describe, expect, test } from 'bun:test';
import { DOCS_ORIGIN_COMMAND, docsOriginReader, judgeDocsOrigin } from './health-docs-origin';
import type { RunResult } from './run';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const ORIGIN = [{ name: 'DOCS_SITE_ORIGIN', value: 'https://docs.example.org' }];
const pages = (extra: Record<string, unknown> = {}) => ({
  cname: 'docs.example.org',
  https_enforced: true,
  https_certificate: { state: 'approved', expires_at: '2027-02-08' },
  ...extra,
});
const judge = (variables: unknown, site: unknown) =>
  judgeDocsOrigin({ variables, pages: site }, NOW);
const verdict = (variables: unknown, site: unknown) => {
  const out = judge(variables, site);
  return 'verdict' in out ? out.verdict : out.code;
};

describe('row · the docs-site origin serves', () => {
  test('the variable set, Pages on its host, HTTPS approved and enforced is healthy', () => {
    expect(verdict(ORIGIN, pages())).toBe('healthy');
  });

  test('no DOCS_SITE_ORIGIN is unhealthy: every deploy job skips', () => {
    expect(judge([], pages())).toMatchObject({
      verdict: 'unhealthy',
      fix: 'gh variable set DOCS_SITE_ORIGIN --body https://docs.example.org',
    });
  });

  test('Pages off is unhealthy, with the call that turns it on', () => {
    expect(judge(ORIGIN, { message: 'Not Found', status: '404' })).toMatchObject({
      verdict: 'unhealthy',
      fix: 'gh api -X POST repos/{owner}/{repo}/pages -f build_type=workflow',
    });
  });

  test('a Pages host off the origin is unhealthy, with the call that moves it', () => {
    expect(judge(ORIGIN, pages({ cname: 'old.example.org' }))).toMatchObject({
      verdict: 'unhealthy',
      fix: 'gh api -X PUT repos/{owner}/{repo}/pages -f cname=docs.example.org',
    });
    expect(verdict(ORIGIN, pages({ cname: null }))).toBe('unhealthy');
  });

  test('a certificate not approved, expired, or HTTPS not enforced is unhealthy', () => {
    const pending = pages({ https_certificate: { state: 'new', expires_at: null } });
    expect(verdict(ORIGIN, pending)).toBe('unhealthy');
    const expired = pages({ https_certificate: { state: 'approved', expires_at: '2026-11-01' } });
    expect(verdict(ORIGIN, expired)).toBe('unhealthy');
    expect(judge(ORIGIN, pages({ https_enforced: false }))).toMatchObject({
      verdict: 'unhealthy',
      fix: 'gh api -X PUT repos/{owner}/{repo}/pages -F https_enforced=true',
    });
  });

  test('a token that may not read variables is no verdict, naming the command', () => {
    expect(judge('forbidden', pages())).toMatchObject({
      verdict: 'unverdicted',
      fix: DOCS_ORIGIN_COMMAND,
    });
  });

  test('junk on either read is unreadable', () => {
    expect(verdict(undefined, pages())).toBe('X_HEALTH_ROW_UNREADABLE');
    expect(verdict(ORIGIN, undefined)).toBe('X_HEALTH_ROW_UNREADABLE');
    expect(verdict(ORIGIN, { message: 'Server Error' })).toBe('X_HEALTH_ROW_UNREADABLE');
  });

  test("gh's real 404 — a pretty-printed body, then its own line — reads as Pages off", async () => {
    const notFound = '{\n  "message": "Not Found",\n  "status": "404"\n}\ngh: Not Found (HTTP 404)';
    const gh = async (args: readonly string[]): Promise<RunResult> => {
      const pagesCall = args[0] === 'api';
      const output = pagesCall ? notFound : JSON.stringify(ORIGIN);
      return {
        command: args,
        code: pagesCall ? 1 : 0,
        ok: !pagesCall,
        output,
        durationMs: 1,
        timedOut: false,
      };
    };
    expect(judgeDocsOrigin(await docsOriginReader('.', gh), NOW)).toMatchObject({
      verdict: 'unhealthy',
      fix: 'gh api -X POST repos/{owner}/{repo}/pages -f build_type=workflow',
    });
  });

  test('the reader asks gh exactly the row command', async () => {
    const asked: string[] = [];
    const gh = async (args: readonly string[]): Promise<RunResult> => {
      asked.push(['gh', ...args].join(' '));
      return { command: args, code: 0, ok: true, output: '[]', durationMs: 1, timedOut: false };
    };
    await docsOriginReader('.', gh);
    expect(asked.join('; ')).toBe(DOCS_ORIGIN_COMMAND);
    expect(DOCS_ORIGIN_COMMAND).toBe(
      'gh variable list --json name,value; gh api repos/{owner}/{repo}/pages',
    );
  });
});
