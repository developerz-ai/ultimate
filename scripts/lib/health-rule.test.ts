// Every verdict branch of the eight health rows, driven by narrowed fixtures: a row that answers
// `healthy` on a run it could not place, or `unhealthy` on a run still in flight, files an ask
// nobody can act on — so each "no verdict" branch is held as carefully as each red one.

import { describe, expect, test } from 'bun:test';
import type { AuditState, RunRow } from './health-narrow';
import {
  alarmsVerdict,
  demoShippedVerdict,
  dependabotVerdict,
  lastTagVerdict,
  mainGreenVerdict,
  npmTreeVerdict,
  stampedTaggedVerdict,
  tagRunsVerdict,
  todayAuditMs,
} from './health-rule';

const TIP = 'a1b2c3';
const run = (over: Partial<RunRow> = {}): RunRow => ({
  conclusion: 'success',
  headSha: TIP,
  ...over,
});
const NOW = Date.UTC(2026, 10, 16, 12, 0);

describe('row 1 · main green', () => {
  const verdict = (runs: readonly RunRow[], runNotFound = false) =>
    mainGreenVerdict({ ci: { ok: true, runNotFound, runs }, expectedSha: TIP });

  test('no run at all is no verdict, and says why', () => {
    expect(verdict([]).verdict).toBe('unverdicted');
    expect(verdict([]).reason).toContain('no push run on main to read');
    expect(verdict([], true).reason).toContain('X_CI_RUN_NOT_FOUND');
  });

  test('a run still in flight with no green before it is no verdict', () => {
    const answer = verdict([run({ conclusion: null, status: 'queued' })]);
    expect(answer.verdict).toBe('unverdicted');
    expect(answer.reason).toContain('still queued');
    expect(verdict([run({ conclusion: null })]).reason).toContain('still running');
  });

  test('a finished red run with no green is unhealthy', () => {
    const answer = verdict([run({ conclusion: 'failure' })]);
    expect(answer.verdict).toBe('unhealthy');
    expect(answer.reason).toContain('ended failure');
  });

  test('green at another commit is unhealthy: the tip itself has no green run', () => {
    expect(verdict([run({ headSha: 'old' })]).reason).toContain('green at old, not at');
    expect(verdict([run({ headSha: undefined })]).reason).toContain('an unreadable sha');
  });

  test('green at the tip is healthy', () => {
    expect(verdict([run()]).verdict).toBe('healthy');
  });
});

describe('row 2 · last tag published', () => {
  const verdict = (one: RunRow | undefined) => lastTagVerdict({ tagCommit: TIP, run: one });

  test('no run, no sha, another sha and a run in flight are each no verdict', () => {
    expect(verdict(undefined).reason).toContain('no run yet');
    expect(verdict(run({ headSha: undefined })).reason).toContain('names no headSha');
    expect(verdict(run({ headSha: 'other' })).reason).toContain('another commit (other)');
    expect(verdict(run({ conclusion: null })).reason).toContain('has not finished');
    for (const one of [undefined, run({ headSha: undefined }), run({ conclusion: null })]) {
      expect(verdict(one).verdict).toBe('unverdicted');
    }
  });

  test('a finished run at the tag decides it either way', () => {
    expect(verdict(run()).verdict).toBe('healthy');
    const red = verdict(run({ conclusion: 'cancelled' }));
    expect(red.verdict).toBe('unhealthy');
    expect(red.reason).toContain('ended cancelled');
  });
});

describe('row 3 · stamped version tagged', () => {
  test('awaiting a tag is unhealthy whatever the last tag is', () => {
    expect(stampedTaggedVerdict({ lastTag: 'v1.0.0', reason: 'awaiting_tag' }).verdict).toBe(
      'unhealthy',
    );
  });

  test('no last tag is no verdict, and one is healthy', () => {
    expect(stampedTaggedVerdict({ lastTag: undefined, reason: undefined }).verdict).toBe(
      'unverdicted',
    );
    const ok = stampedTaggedVerdict({ lastTag: 'v1.0.0', reason: 'up_to_date' });
    expect(ok.verdict).toBe('healthy');
    expect(ok.reason).toContain('v1.0.0');
  });
});

describe('row 4 · tag runs ended well', () => {
  test('a failure outranks a run still going', () => {
    const answer = tagRunsVerdict({
      runs: [run({ conclusion: null }), run({ conclusion: 'timed_out' })],
    });
    expect(answer.verdict).toBe('unhealthy');
    expect(answer.reason).toContain('timed_out');
  });

  test('a run still going is no verdict; skipped and success are healthy', () => {
    const going = tagRunsVerdict({ runs: [run({ conclusion: null, status: 'in_progress' })] });
    expect(going.verdict).toBe('unverdicted');
    expect(going.reason).toContain('still in_progress');
    expect(tagRunsVerdict({ runs: [run({ conclusion: null })] }).reason).toContain('running');
    const fine = tagRunsVerdict({ runs: [run(), run({ conclusion: 'skipped' })] });
    expect(fine.verdict).toBe('healthy');
    expect(fine.reason).toContain('2 recent');
  });
});

describe('row 5 · npm serves the tree', () => {
  const state = (over: Partial<AuditState> = {}): AuditState => ({
    name: '@ultimat3/core',
    version: '1.0.0',
    kind: 'ok',
    latest: '1.0.0',
    tagged: true,
    ...over,
  });
  const verdict = (states: readonly AuditState[], ok = true, findings: string[] = []) =>
    npmTreeVerdict({ audit: { ok, findings, states } });

  test("the audit's own refusal is unhealthy, its codes named", () => {
    expect(verdict([], false, ['X_REGISTRY_UNREACHABLE']).reason).toContain(
      'X_REGISTRY_UNREACHABLE',
    );
    expect(verdict([], false).reason).toContain('no readable findings');
  });

  test('git not saying whether a version is tagged is no verdict', () => {
    expect(verdict([state({ tagged: undefined })]).verdict).toBe('unverdicted');
  });

  test('a package not ok, a split latest and an untagged version are each unhealthy', () => {
    expect(verdict([state({ kind: 'behind' })]).reason).toContain('is behind on npm');
    expect(verdict([state({ latest: '0.9.0' })]).reason).toContain('X_REGISTRY_LATEST_DRIFT');
    expect(verdict([state({ latest: undefined })]).reason).toContain('is none');
    expect(verdict([state({ tagged: false })]).reason).toContain('v1.0.0 is not tagged');
  });

  test('every package at its version, attested and tagged, is healthy', () => {
    expect(verdict([state(), state({ name: '@ultimat3/cli' })]).reason).toContain('all 2');
  });
});

describe('row 6 · automation alarms', () => {
  test("today's audit instant is 06:17 UTC on the day of now", () => {
    expect(new Date(todayAuditMs(NOW)).toISOString()).toBe('2026-11-16T06:17:00.000Z');
  });

  test('no issue is healthy', () => {
    expect(alarmsVerdict({ issues: [], nowMs: NOW }).verdict).toBe('healthy');
  });

  test('each issue is named latched or re-firing against the audit instant', () => {
    const answer = alarmsVerdict({
      issues: [
        { number: 7, updatedAt: '2026-11-15T09:00:00Z' },
        { number: 8, updatedAt: '2026-11-16T07:00:00Z' },
        { number: 9 },
      ],
      nowMs: NOW,
    });
    expect(answer.verdict).toBe('unhealthy');
    expect(answer.latched).toBe(false);
    expect(answer.reason).toContain('#7 latched');
    expect(answer.reason).toContain('#8 re-firing');
    expect(answer.reason).toContain('#9 re-firing');
    const latched = alarmsVerdict({
      issues: [{ number: 7, updatedAt: '2026-11-15T09:00:00Z' }],
      nowMs: NOW,
    });
    expect(latched.latched).toBe(true);
  });
});

describe('row 7 · dependabot not stuck', () => {
  const OLD = '2026-11-01T00:00:00Z';
  const FRESH = '2026-11-15T00:00:00Z';

  test('a red PR idle past a week is stuck, even beside an unreadable one', () => {
    const answer = dependabotVerdict({
      prs: [
        { number: 1, checks: 'red', updatedAt: OLD },
        { number: 2, checks: 'unknown', updatedAt: undefined },
      ],
      nowMs: NOW,
    });
    expect(answer.verdict).toBe('unhealthy');
    expect(answer.reason).toContain('#1 inactive since');
  });

  test('an unreadable updatedAt and pending checks are each no verdict', () => {
    expect(
      dependabotVerdict({ prs: [{ number: 2, checks: 'green' }], nowMs: NOW }).reason,
    ).toContain('readable updatedAt');
    expect(
      dependabotVerdict({ prs: [{ number: 3, checks: 'unknown', updatedAt: FRESH }], nowMs: NOW })
        .reason,
    ).toContain('pending or unknown');
  });

  test('a red PR active this week is not stuck', () => {
    const answer = dependabotVerdict({
      prs: [{ number: 4, checks: 'red', updatedAt: FRESH }],
      nowMs: NOW,
    });
    expect(answer.verdict).toBe('healthy');
  });
});

describe('row 8 · demo shipped', () => {
  const verdict = (one: RunRow | undefined, main: 'healthy' | 'unhealthy' | 'unverdicted') =>
    demoShippedVerdict({ run: one }, main);

  test('no run, a run in flight and an operator dispatch are each no verdict', () => {
    expect(verdict(undefined, 'healthy').reason).toContain('no run yet');
    expect(verdict(run({ conclusion: null }), 'healthy').reason).toContain('still running');
    const dispatched = verdict(run({ event: 'workflow_dispatch' }), 'healthy');
    expect(dispatched.verdict).toBe('unverdicted');
    expect(dispatched.reason).toContain('on a ref');
  });

  test('a green push publish is healthy', () => {
    expect(verdict(run({ event: 'workflow_run' }), 'healthy').verdict).toBe('healthy');
  });

  test("a skip is this row's ask only while main is green", () => {
    const skipped = run({ conclusion: 'skipped', event: 'workflow_run' });
    expect(verdict(skipped, 'healthy').verdict).toBe('unhealthy');
    expect(verdict(skipped, 'unhealthy').reason).toContain('main-green row files that ask alone');
    expect(verdict(skipped, 'unverdicted').reason).toContain('has no verdict');
  });

  test('any other end names the two guards', () => {
    const answer = verdict(run({ conclusion: 'failure', event: 'workflow_run' }), 'healthy');
    expect(answer.verdict).toBe('unhealthy');
    expect(answer.reason).toContain('not-on-main-tip guard');
  });
});
