// The orchestrator over injected readers, its jsonDocument stderr-noise scan, and one real spawn
// with nothing on PATH — a row the script cannot read must refuse the whole answer. No network, no
// real checkout: the pure rules behind the verdicts are pinned here too, one row at a time through
// the same injected readers, not in a file of their own.

import { describe, expect, test } from 'bun:test';
import type { HealthOverrides } from './health';
import { CI_ARGS, healthAt, jsonDocument } from './health';
import type { DependabotPr } from './lib/health-narrow';
import { narrowPrs } from './lib/health-narrow';
import type { RowVerdict } from './lib/health-rule';
import { dependabotVerdict, ROW_IDS } from './lib/health-rule';
import type { ScriptResult } from './lib/log';

const SHA = 'a'.repeat(40);

const verdictOf = (result: ScriptResult): readonly RowVerdict[] => {
  const data = result.data as { healthy: boolean; rows: readonly RowVerdict[] } | undefined;
  if (data === undefined) return expect.unreachable('ok:true always carries data.rows');
  return data.rows;
};

describe('unit · health · jsonDocument', () => {
  // Pins the stderr-noise line-scan: gh writes progress above the document — deleted green,
  // the second case would refuse an answer that is present.
  test('the whole output when it is one document', () => {
    expect(jsonDocument('{"ok":true,"data":{}}\n')).toEqual({ ok: true, data: {} });
  });

  test('the last object line wins when stderr noise precedes the document', () => {
    expect(jsonDocument('progress line\n{"ok":false,"findings":[]}')).toEqual({
      ok: false,
      findings: [],
    });
  });

  test('no object line anywhere is undefined — never an invented answer', () => {
    expect(jsonDocument('')).toBeUndefined();
    expect(jsonDocument('fatal: not a git repository\nerror: no runs')).toBeUndefined();
  });
});

describe('unit · health · the main-green argv', () => {
  // The prefix IS the fix: run() spawns argv[0] directly, and `run` is no binary on a normal Bun
  // installation — dropped, the row refuses everywhere the script runs.
  test('it runs bun run x, not a binary named run', () => {
    expect(CI_ARGS[0]).toBe('bun');
    expect(CI_ARGS[1]).toBe('run');
  });
});

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
};
describe('unit · health · healthAt over injected readers', () => {
  test('a readable world answers ok:true with all eight rows in the brief order', async () => {
    const result = await healthAt('.', healthyReaders);
    expect(result.ok).toBe(true);
    expect(result.script).toBe('health');
    expect(result.findings).toBeUndefined();
    const rows = verdictOf(result);
    expect(rows.map((row) => row.row)).toEqual([...ROW_IDS]);
    const data = result.data as { healthy: boolean };
    expect(data.healthy).toBe(true);
  });

  test('an unhealthy row leaves ok:true and turns the healthy flag off', async () => {
    // Ancient on purpose: healthAt reads the real clock, so the fixture must be stuck under ANY now.
    const result = await healthAt('.', {
      ...healthyReaders,
      'dependabot-not-stuck': async () => ({
        prs: [
          {
            number: 801,
            createdAt: '2020-01-01T00:00:00Z',
            updatedAt: '2020-01-02T00:00:00Z',
            statusCheckRollup: [{ __typename: 'StatusContext', state: 'FAILURE' }],
          },
        ],
      }),
    });
    expect(result.ok).toBe(true);
    const rows = verdictOf(result);
    expect((result.data as { healthy: boolean }).healthy).toBe(false);
    expect(rows.find((row) => row.row === 'dependabot-not-stuck')?.verdict).toBe('unhealthy');
  });

  test('a refused child passes its findings through VERBATIM, with no data', async () => {
    const result = await healthAt('.', {
      ...healthyReaders,
      'stamped-version-tagged': async () => ({
        releaseDue: {
          ok: false,
          findings: [
            {
              code: 'X_RELEASE_TAG_UNREACHABLE',
              cause: 'no tag reachable',
              fix: 'git fetch --tags origin',
            },
          ],
        },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('cannot tell');
    expect(result.data).toBeUndefined();
    // The WHOLE finding, not just its code: cause and fix are the repair instructions the ask
    // quotes, so dropping or rewriting either must fail here.
    expect(result.findings).toEqual([
      {
        code: 'X_RELEASE_TAG_UNREACHABLE',
        cause: 'no tag reachable',
        fix: 'git fetch --tags origin',
      },
    ]);
  });

  test('a reader that throws — Bun.spawn on a missing binary — is one unreadable row, refusing all', async () => {
    const result = await healthAt('.', {
      ...healthyReaders,
      // A rejected promise, not a throw: this error is healthAt's INPUT — the foreign refusal
      // Bun.spawn hands a missing binary — and the bare-throw ratchet counts the throw form.
      'automation-alarms': () =>
        Promise.reject(new TypeError('Executable not found in $PATH: "gh"')),
    });
    expect(result.ok).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.findings?.length).toBeGreaterThan(0);
    expect(result.findings?.[0]?.code).toBe('X_HEALTH_ROW_UNREADABLE');
    expect(result.findings?.[0]?.cause).toContain('gh');
    expect(result.findings?.[0]?.fix).toBe('bun run scripts/health.ts --json');
  });

  test('a reader answering junk is unreadable, never a made-up verdict', async () => {
    // `undefined` is no document at all; `{}` is not a run list; `[{}]` names runs none of which
    // read. All three must refuse: an empty list is this row's `healthy`, so a junk document that
    // narrowed to [] would green the tag over nothing.
    for (const runs of [undefined, {}, [{}]]) {
      const result = await healthAt('.', {
        ...healthyReaders,
        'tag-runs-ended-well': async () => ({ runs }),
      });
      expect(result.ok).toBe(false);
      expect(result.data).toBeUndefined();
      expect(result.findings?.[0]?.code).toBe('X_HEALTH_ROW_UNREADABLE');
    }
  });

  test('a main-green refusal without X_CI_RUN_NOT_FOUND is unreadable, not silent', async () => {
    const result = await healthAt('.', {
      ...healthyReaders,
      'main-green': async () => ({ ci: { ok: false }, expectedSha: SHA }),
    });
    expect(result.ok).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.findings?.[0]?.code).toBe('X_HEALTH_ROW_UNREADABLE');
    expect(result.findings?.[0]?.cause).toContain('refused without naming a missing run');
  });

  test('a last-tag run list with no document is unreadable, not a silent verdict', async () => {
    const result = await healthAt('.', {
      ...healthyReaders,
      'last-tag-published': async () => ({ tagCommit: SHA, runs: undefined }),
    });
    expect(result.ok).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.findings?.[0]?.code).toBe('X_HEALTH_ROW_UNREADABLE');
  });

  test('a release run with no headSha is no verdict, even on success', async () => {
    // Match-only means the sha: a run that names none cannot be placed at the tag's peeled
    // commit, so its `success` must read as nothing — never as a published tag.
    const result = await healthAt('.', {
      ...healthyReaders,
      'last-tag-published': async () => ({
        tagCommit: SHA,
        runs: [{ conclusion: 'success', event: 'workflow_dispatch' }],
      }),
    });
    expect(result.ok).toBe(true);
    const rows = verdictOf(result);
    expect(rows.find((row) => row.row === 'last-tag-published')?.verdict).toBe('unverdicted');
    expect((result.data as { healthy: boolean }).healthy).toBe(false);
  });

  test('a release run at another commit than the tag is no verdict, even on success', async () => {
    const result = await healthAt('.', {
      ...healthyReaders,
      'last-tag-published': async () => ({
        tagCommit: SHA,
        runs: [{ conclusion: 'success', headSha: 'b'.repeat(40) }],
      }),
    });
    expect(result.ok).toBe(true);
    const rows = verdictOf(result);
    expect(rows.find((row) => row.row === 'last-tag-published')?.verdict).toBe('unverdicted');
  });

  test('a skipped deploy under a red main is no second ask — the deploy row is unverdicted', async () => {
    const result = await healthAt('.', {
      ...healthyReaders,
      'main-green': async () => ({
        ci: {
          ok: true,
          data: { runs: [{ conclusion: 'failure', status: 'completed', headSha: SHA, id: 11 }] },
        },
        expectedSha: SHA,
      }),
      'demo-shipped': async () => ({
        runs: [{ conclusion: 'skipped', event: 'workflow_run', status: 'completed' }],
      }),
    });
    expect(result.ok).toBe(true);
    const rows = verdictOf(result);
    expect(rows.find((row) => row.row === 'main-green')?.verdict).toBe('unhealthy');
    expect(rows.find((row) => row.row === 'demo-shipped')?.verdict).toBe('unverdicted');
    expect((result.data as { healthy: boolean }).healthy).toBe(false);
  });

  test('a skipped deploy under a green main is unhealthy here — a non-push ci run', async () => {
    const result = await healthAt('.', {
      ...healthyReaders,
      'demo-shipped': async () => ({
        runs: [{ conclusion: 'skipped', event: 'workflow_run', status: 'completed' }],
      }),
    });
    const rows = verdictOf(result);
    expect(rows.find((row) => row.row === 'main-green')?.verdict).toBe('healthy');
    expect(rows.find((row) => row.row === 'demo-shipped')?.verdict).toBe('unhealthy');
    expect(rows.find((row) => row.row === 'demo-shipped')?.reason).toContain('non-push');
  });
});

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

describe('unit · health · the script, spawned', () => {
  // Copied from deploy-proof-due.test.ts:148 — no repoRoot() here, no real tree: the child runs
  // THIS directory with nothing on PATH, so every read throws before any subprocess is waited on.
  test('with nothing on PATH it exits 1: ok:false, findings, no data', async () => {
    const dir = `${Bun.env['TMPDIR'] ?? '/tmp'}/health-${crypto.randomUUID()}`;
    const proc = Bun.spawn([process.execPath, `${import.meta.dir}/health.ts`, '--json'], {
      cwd: import.meta.dir,
      env: { PATH: `${dir}/no-such-bin` },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const answer = JSON.parse(stdout) as {
      ok: boolean;
      findings: { code: string }[];
      data?: unknown;
    };
    expect(code).toBe(1);
    expect(answer.ok).toBe(false);
    expect(answer.findings.length).toBeGreaterThan(0);
    expect(answer.findings[0]?.code).toBe('X_HEALTH_ROW_UNREADABLE');
    expect(answer.data).toBeUndefined();
  });
});
