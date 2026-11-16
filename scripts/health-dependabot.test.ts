// Row 7's world on its own: one Dependabot PR page judged on inactivity — failed checks with more
// than seven days since `updatedAt` file the stuck ask, green or fresh pages stay healthy, and
// pending or unreadable evidence is unverdicted, never a mute on a confirmed failure. Split from
// health.ts.test.ts: this row's cases plus the row-4 evidence pins breach the ceiling together.

import { describe, expect, test } from 'bun:test';
import type { HealthOverrides } from './health';
import { healthAt } from './health';
import { healthyReaders as healthyWorld } from './lib/health-fixture';
import type { DependabotPr } from './lib/health-narrow';
import { narrowPrs } from './lib/health-narrow';
import type { RowVerdict } from './lib/health-rule';
import { dependabotVerdict } from './lib/health-rule';
import type { ScriptResult } from './lib/log';

const verdictOf = (result: ScriptResult): readonly RowVerdict[] => {
  const data = result.data as { healthy: boolean; rows: readonly RowVerdict[] } | undefined;
  if (data === undefined) return expect.unreachable('ok:true always carries data.rows');
  return data.rows;
};

const healthyReaders: HealthOverrides = healthyWorld();

describe('unit · health · Dependabot activity and checks', () => {
  const nowMs = Date.parse('2026-10-23T12:00:00Z');
  const weekMs = 7 * 24 * 3_600_000;
  const green = { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' };
  const red = { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' };
  const cases = [
    { name: 'old creation, recent red update', age: 1, checks: [red], verdict: 'healthy' },
    { name: 'stale red', age: weekMs + 1, checks: [red], verdict: 'unhealthy' },
    { name: 'stale green', age: weekMs + 1, checks: [green], verdict: 'healthy' },
    { name: 'exactly seven days red', age: weekMs, checks: [red], verdict: 'healthy' },
    {
      name: 'pending check run',
      age: weekMs + 1,
      checks: [{ ...red, status: 'IN_PROGRESS', conclusion: null }],
      verdict: 'unverdicted',
    },
    {
      name: 'pending status context',
      age: weekMs + 1,
      checks: [{ __typename: 'StatusContext', state: 'PENDING' }],
      verdict: 'unverdicted',
    },
    {
      name: 'successful status context',
      age: weekMs + 1,
      checks: [{ __typename: 'StatusContext', state: 'SUCCESS' }],
      verdict: 'healthy',
    },
    {
      name: 'failed status context',
      age: weekMs + 1,
      checks: [{ __typename: 'StatusContext', state: 'ERROR' }],
      verdict: 'unhealthy',
    },
    {
      name: 'neutral and skipped runs',
      age: weekMs + 1,
      checks: [
        { ...green, conclusion: 'NEUTRAL' },
        { ...green, conclusion: 'SKIPPED' },
      ],
      verdict: 'healthy',
    },
    {
      name: 'unknown mixed with green',
      age: weekMs + 1,
      checks: [green, {}],
      verdict: 'unverdicted',
    },
    {
      name: 'pending mixed with red',
      age: weekMs + 1,
      checks: [red, { ...green, status: 'QUEUED' }],
      verdict: 'unverdicted',
    },
    { name: 'no checks', age: weekMs + 1, checks: [], verdict: 'unverdicted' },
  ] as const;

  for (const one of cases) {
    test(one.name, async () => {
      const raw = [
        {
          number: 802,
          createdAt: '2020-01-01T00:00:00Z',
          updatedAt: new Date(nowMs - one.age).toISOString(),
          statusCheckRollup: one.checks,
        },
      ];
      const prs = narrowPrs(raw);
      expect(dependabotVerdict({ prs, nowMs }).verdict).toBe(one.verdict);
      // Translate the fixed inactivity to the reader's real clock, without a boundary race.
      const readerAge = one.age <= weekMs ? 0 : weekMs * 2;
      const result = await healthAt('.', {
        ...healthyReaders,
        'dependabot-not-stuck': async () => ({
          prs: [{ ...raw[0], updatedAt: new Date(Date.now() - readerAge).toISOString() }],
        }),
      });
      expect(verdictOf(result).find((row) => row.row === 'dependabot-not-stuck')?.verdict).toBe(
        one.verdict,
      );
    });
  }

  test('a confirmed stuck PR files even with a separate pending PR on the page', () => {
    // The bug this pins: the row-wide pending gate used to shadow the page's one confirmed
    // failure — `unverdicted` never files, so the stuck-PR alarm went silent.
    const page = narrowPrs([
      {
        number: 805,
        createdAt: '2020-01-01T00:00:00Z',
        updatedAt: new Date(nowMs - weekMs - 1).toISOString(),
        statusCheckRollup: [red],
      },
      {
        number: 806,
        createdAt: '2020-01-01T00:00:00Z',
        updatedAt: new Date(nowMs).toISOString(),
        statusCheckRollup: [{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null }],
      },
    ]);
    const verdict = dependabotVerdict({ prs: page, nowMs });
    expect(verdict.verdict).toBe('unhealthy');
    expect(verdict.reason).toContain('#805');
    expect(verdict.reason).not.toContain('#806');
  });

  test('a confirmed stuck PR files even when a separate PR has an unreadable updatedAt', () => {
    const page = narrowPrs([
      {
        number: 807,
        createdAt: '2020-01-01T00:00:00Z',
        updatedAt: new Date(nowMs - weekMs - 1).toISOString(),
        statusCheckRollup: [red],
      },
      { number: 808, createdAt: '2020-01-01T00:00:00Z', statusCheckRollup: [green] },
    ]);
    const verdict = dependabotVerdict({ prs: page, nowMs });
    expect(verdict.verdict).toBe('unhealthy');
    expect(verdict.reason).toContain('#807');
  });

  test('a page of unresolved evidence with no confirmed failure stays unverdicted', () => {
    const page = narrowPrs([
      {
        number: 809,
        createdAt: '2020-01-01T00:00:00Z',
        updatedAt: new Date(nowMs).toISOString(),
        statusCheckRollup: [{ __typename: 'CheckRun', status: 'QUEUED', conclusion: null }],
      },
    ]);
    expect(dependabotVerdict({ prs: page, nowMs }).verdict).toBe('unverdicted');
  });

  test('through healthAt, a full page with no stuck PR is truncated: no verdict', async () => {
    const pr = (number: number) => ({
      number,
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: new Date().toISOString(),
      statusCheckRollup: [red],
    });
    const full = await healthAt('.', {
      ...healthyReaders,
      'dependabot-not-stuck': async () => ({ prs: [1, 2, 3, 4, 5].map(pr) }),
    });
    const row = verdictOf(full).find((one) => one.row === 'dependabot-not-stuck');
    expect(row?.verdict).toBe('unverdicted');
    expect(row?.reason).toContain('--limit');
  });

  test('through healthAt, a full page still files the stuck PRs it holds', async () => {
    // The page is truncated, but a confirmed stuck PR on it is confirmed: unverdicted never mutes it.
    const pr = (number: number) => ({
      number,
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2020-01-02T00:00:00Z',
      statusCheckRollup: [red],
    });
    for (const numbers of [
      [1, 2, 3, 4, 5],
      [1, 2, 3, 4],
    ]) {
      const result = await healthAt('.', {
        ...healthyReaders,
        'dependabot-not-stuck': async () => ({ prs: numbers.map(pr) }),
      });
      const row = verdictOf(result).find((one) => one.row === 'dependabot-not-stuck');
      expect(row?.verdict).toBe('unhealthy');
      expect(row?.reason).toContain('#1 inactive');
    }
  });

  test('through healthAt, a mixed page files the stuck ask and turns healthy off', async () => {
    // 14 days: over the threshold under any clock the reader hands the script.
    const result = await healthAt('.', {
      ...healthyReaders,
      'dependabot-not-stuck': async () => ({
        prs: [
          {
            number: 810,
            createdAt: '2020-01-01T00:00:00Z',
            updatedAt: new Date(Date.now() - weekMs * 2).toISOString(),
            statusCheckRollup: [red],
          },
          {
            number: 811,
            createdAt: '2020-01-01T00:00:00Z',
            updatedAt: new Date(Date.now()).toISOString(),
            statusCheckRollup: [
              { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null },
            ],
          },
        ],
      }),
    });
    expect(result.ok).toBe(true);
    expect((result.data as { healthy: boolean }).healthy).toBe(false);
    const row = verdictOf(result).find((one) => one.row === 'dependabot-not-stuck');
    expect(row?.verdict).toBe('unhealthy');
    expect(row?.reason).toContain('#810');
  });

  test('unreadable activity never falls back to creation, even for green checks', async () => {
    for (const updatedAt of [undefined, '', 'invalid']) {
      for (const statusCheckRollup of [[green], [red]]) {
        const raw = [
          {
            number: 803,
            createdAt: '2020-01-01T00:00:00Z',
            updatedAt,
            statusCheckRollup,
          },
        ];
        expect(dependabotVerdict({ prs: narrowPrs(raw), nowMs }).verdict).toBe('unverdicted');
        const result = await healthAt('.', {
          ...healthyReaders,
          'dependabot-not-stuck': async () => ({ prs: raw }),
        });
        expect(verdictOf(result).find((row) => row.row === 'dependabot-not-stuck')?.verdict).toBe(
          'unverdicted',
        );
      }
    }
  });

  test('pure rule uses updatedAt and preserves the strict inactivity boundary', () => {
    const pr: DependabotPr = {
      number: 804,
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: new Date(nowMs - weekMs).toISOString(),
      checks: 'red',
    };
    expect(dependabotVerdict({ prs: [pr], nowMs }).verdict).toBe('healthy');
    const stale = dependabotVerdict({ prs: [pr], nowMs: nowMs + 1 });
    expect(stale.verdict).toBe('unhealthy');
    expect(stale.reason).toContain(pr.updatedAt ?? 'missing');
    expect(stale.reason).not.toContain(pr.createdAt ?? 'missing');
  });
});
