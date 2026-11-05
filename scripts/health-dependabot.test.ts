// Row 7's world on its own: one Dependabot PR page judged on inactivity — failed checks with more
// than seven days since `updatedAt` file the stuck ask, green or fresh pages short of the reader's
// --limit stay healthy, a page as FULL as the limit is unverdicted (PRs beyond it are unread), and
// pending or unreadable evidence is unverdicted, never a mute on a confirmed failure. Split from
// health.ts.test.ts: this row's cases plus the row-4 evidence pins breach the ceiling together.

import { describe, expect, test } from 'bun:test';
import type { HealthOverrides } from './health';
import { DEPENDABOT_PAGE_LIMIT, healthAt } from './health';
import type { DependabotPr } from './lib/health-narrow';
import { narrowPrs } from './lib/health-narrow';
import type { RowVerdict } from './lib/health-rule';
import { dependabotVerdict } from './lib/health-rule';
import type { ScriptResult } from './lib/log';

const SHA = 'a'.repeat(40);

const verdictOf = (result: ScriptResult): readonly RowVerdict[] => {
  const data = result.data as { healthy: boolean; rows: readonly RowVerdict[] } | undefined;
  if (data === undefined) return expect.unreachable('ok:true always carries data.rows');
  return data.rows;
};

const healthyReaders: HealthOverrides = {
  'main-green': async () => ({
    ci: {
      ok: true,
      data: { runs: [{ conclusion: 'success', status: 'completed', headSha: SHA, id: 11 }] },
    },
    expectedSha: SHA,
  }),
  'last-tag-published': async () => ({
    tagCommit: SHA,
    runs: [{ conclusion: 'success', event: 'workflow_dispatch', headSha: SHA }],
  }),
  'stamped-version-tagged': async () => ({
    releaseDue: { ok: true, data: { lastTag: 'v3.0.0', reason: 'settled' } },
  }),
  'tag-runs-ended-well': async () => ({
    runs: [{ conclusion: 'success', status: 'completed' }],
  }),
  'npm-serves-tree': async () => ({
    audit: {
      ok: true,
      data: {
        states: [
          { name: '@ultimat3/core', version: '3.0.0', kind: 'ok', latest: '3.0.0', tagged: true },
        ],
      },
    },
  }),
  'automation-alarms': async () => ({ issues: [] }),
  'dependabot-not-stuck': async () => ({ prs: [] }),
  'demo-shipped': async () => ({
    runs: [{ conclusion: 'success', event: 'workflow_run', status: 'completed', databaseId: 5 }],
  }),
  // Row 9 joined health.ts with this merge; without it the default reader spawns real git and gh
  // here, and an environment where gh refuses turns every healthAt case below into a refusal.
  'release-exists': async () => ({
    tag: 'v3.0.0',
    lookup: {
      kind: 'found',
      release: { tagName: 'v3.0.0', isDraft: false, publishedAt: '2026-01-01T00:00:00Z' },
    },
  }),
};

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
      expect(dependabotVerdict({ prs, nowMs, pageLimit: DEPENDABOT_PAGE_LIMIT }).verdict).toBe(
        one.verdict,
      );
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
    const verdict = dependabotVerdict({ prs: page, nowMs, pageLimit: DEPENDABOT_PAGE_LIMIT });
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
    const verdict = dependabotVerdict({ prs: page, nowMs, pageLimit: DEPENDABOT_PAGE_LIMIT });
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
    expect(dependabotVerdict({ prs: page, nowMs, pageLimit: DEPENDABOT_PAGE_LIMIT }).verdict).toBe(
      'unverdicted',
    );
  });

  test('a full page of green fresh PRs is unverdicted, never healthy', async () => {
    // The bug this pins: gh was asked for 5 PRs and returned 5, so PRs beyond the page are unread
    // — `healthy` over that world is the silent green this row refuses to file.
    const raw = Array.from({ length: DEPENDABOT_PAGE_LIMIT }, (_, at) => ({
      number: 900 + at,
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: new Date(nowMs).toISOString(),
      statusCheckRollup: [green],
    }));
    const page = narrowPrs(raw);
    const pure = dependabotVerdict({ prs: page, nowMs, pageLimit: DEPENDABOT_PAGE_LIMIT });
    expect(pure.verdict).toBe('unverdicted');
    expect(pure.prs).toBe(page);
    expect(pure.reason).toContain(`at the ${DEPENDABOT_PAGE_LIMIT} --limit`);
    // Through the reader, on the reader's real clock to avoid a boundary race.
    const result = await healthAt('.', {
      ...healthyReaders,
      'dependabot-not-stuck': async () => ({
        prs: raw.map((one) => ({ ...one, updatedAt: new Date(Date.now()).toISOString() })),
      }),
    });
    expect(result.ok).toBe(true);
    expect((result.data as { healthy: boolean }).healthy).toBe(false);
    const row = verdictOf(result).find((one) => one.row === 'dependabot-not-stuck');
    expect(row?.verdict).toBe('unverdicted');
    expect(row?.prs).toHaveLength(DEPENDABOT_PAGE_LIMIT);
  });

  test('a full page holding a confirmed stuck PR still files the stuck ask', () => {
    // Gate order: stuck-first outranks the full-page gate, exactly as it outranks the pending and
    // unreadable-updatedAt gates — a confirmed failure is never muted by the page being full.
    const raw = Array.from({ length: DEPENDABOT_PAGE_LIMIT }, (_, at) => ({
      number: 910 + at,
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: new Date(nowMs - (at === 0 ? weekMs + 1 : 0)).toISOString(),
      statusCheckRollup: [at === 0 ? red : green],
    }));
    const verdict = dependabotVerdict({
      prs: narrowPrs(raw),
      nowMs,
      pageLimit: DEPENDABOT_PAGE_LIMIT,
    });
    expect(verdict.verdict).toBe('unhealthy');
    expect(verdict.reason).toContain('#910');
    expect(verdict.reason).not.toContain('#911');
  });

  test('a green page one short of the limit stays healthy', () => {
    const raw = Array.from({ length: DEPENDABOT_PAGE_LIMIT - 1 }, (_, at) => ({
      number: 920 + at,
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: new Date(nowMs).toISOString(),
      statusCheckRollup: [green],
    }));
    expect(
      dependabotVerdict({ prs: narrowPrs(raw), nowMs, pageLimit: DEPENDABOT_PAGE_LIMIT }).verdict,
    ).toBe('healthy');
  });

  test('the 4-vs-5 boundary: the gate reads pageLimit, not a pinned page size', () => {
    // The same four fresh green PRs: short of 5 the row files healthy, filling a limit of 4 it is
    // unverdicted — the comparison is `>=` against the reader's own --limit.
    const raw = Array.from({ length: DEPENDABOT_PAGE_LIMIT - 1 }, (_, at) => ({
      number: 930 + at,
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: new Date(nowMs).toISOString(),
      statusCheckRollup: [green],
    }));
    const page = narrowPrs(raw);
    expect(dependabotVerdict({ prs: page, nowMs, pageLimit: DEPENDABOT_PAGE_LIMIT }).verdict).toBe(
      'healthy',
    );
    expect(dependabotVerdict({ prs: page, nowMs, pageLimit: page.length }).verdict).toBe(
      'unverdicted',
    );
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
        expect(
          dependabotVerdict({ prs: narrowPrs(raw), nowMs, pageLimit: DEPENDABOT_PAGE_LIMIT })
            .verdict,
        ).toBe('unverdicted');
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
    expect(dependabotVerdict({ prs: [pr], nowMs, pageLimit: DEPENDABOT_PAGE_LIMIT }).verdict).toBe(
      'healthy',
    );
    const stale = dependabotVerdict({
      prs: [pr],
      nowMs: nowMs + 1,
      pageLimit: DEPENDABOT_PAGE_LIMIT,
    });
    expect(stale.verdict).toBe('unhealthy');
    expect(stale.reason).toContain(pr.updatedAt ?? 'missing');
    expect(stale.reason).not.toContain(pr.createdAt ?? 'missing');
  });
});
