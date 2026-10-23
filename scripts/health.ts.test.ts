// The orchestrator over injected readers, its jsonDocument stderr-noise scan, and one real spawn
// with nothing on PATH — a row the script cannot read must refuse the whole answer. No network, no
// real checkout: the pure rules behind the verdicts are pinned here too, one row at a time through
// the same injected readers, not in a file of their own.

import { describe, expect, test } from 'bun:test';
import type { HealthOverrides } from './health';
import { CI_ARGS, healthAt } from './health';
import { jsonDocument } from './lib/health-narrow';
import type { RowVerdict } from './lib/health-rule';
import { ROW_IDS } from './lib/health-rule';
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
  'release-exists': async () => ({
    tag: 'v3.0.0',
    lookup: {
      kind: 'found',
      release: { tagName: 'v3.0.0', isDraft: false, publishedAt: '2026-01-01T00:00:00Z' },
    },
  }),
};
describe('unit · health · healthAt over injected readers', () => {
  test('a readable world answers ok:true with all nine rows in the brief order', async () => {
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
        prs: [{ number: 801, createdAt: '2020-01-01T00:00:00Z' }],
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

describe('unit · health · row 7 reads the check rollup, not age alone', () => {
  // healthAt reads the real clock: ages are stated relative to now, never a fixed date — a fixed
  // "young" date goes ancient one day and flips the case it pinned.
  const daysAgo = (days: number): string =>
    new Date(Date.now() - days * 24 * 3_600_000).toISOString();
  const GREEN_ROLLUP = [
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'NEUTRAL' },
    { __typename: 'StatusContext', state: 'SUCCESS' },
  ];
  const row7 = (rows: readonly RowVerdict[]): RowVerdict => {
    const row = rows.find((one) => one.row === 'dependabot-not-stuck');
    if (row === undefined) return expect.unreachable('the dependabot row is always answered');
    return row;
  };
  const withPrs = (prs: unknown): HealthOverrides => ({
    ...healthyReaders,
    'dependabot-not-stuck': async () => ({ prs }),
  });

  test('no open Dependabot PR is healthy', async () => {
    const rows = verdictOf(await healthAt('.', withPrs([])));
    expect(row7(rows).verdict).toBe('healthy');
  });

  test('open PRs none older than 7 days are healthy', async () => {
    const rows = verdictOf(
      await healthAt('.', withPrs([{ number: 900, createdAt: daysAgo(2), state: 'OPEN' }])),
    );
    expect(row7(rows).verdict).toBe('healthy');
  });

  test('a 7+ day PR whose checks read green is unhealthy — merge or close, its url filed', async () => {
    const url = 'https://github.com/ultimate/ultimate/pull/901';
    const rows = verdictOf(
      await healthAt(
        '.',
        withPrs([
          {
            number: 901,
            createdAt: daysAgo(9),
            updatedAt: daysAgo(1),
            state: 'OPEN',
            url,
            autoMergeRequest: null,
            statusCheckRollup: GREEN_ROLLUP,
          },
        ]),
      ),
    );
    const row = row7(rows);
    expect(row.verdict).toBe('unhealthy');
    expect(row.reason).toContain('merge or close');
    expect(row.reason).not.toContain('auto-merge');
    expect(row.prs?.[0]?.url).toBe(url);
  });

  test('a green-stuck PR with autoMergeRequest set names auto-merge in the reason', async () => {
    const rows = verdictOf(
      await healthAt(
        '.',
        withPrs([
          {
            number: 902,
            createdAt: daysAgo(9),
            state: 'OPEN',
            autoMergeRequest: { enabledAt: daysAgo(3) },
            statusCheckRollup: GREEN_ROLLUP,
          },
        ]),
      ),
    );
    const row = row7(rows);
    expect(row.verdict).toBe('unhealthy');
    expect(row.reason).toContain('merge or close');
    expect(row.reason).toContain('auto-merge');
  });

  test('a 7+ day PR whose checks read red is unhealthy — stuck on CI, never merge-or-close', async () => {
    const rows = verdictOf(
      await healthAt(
        '.',
        withPrs([
          {
            number: 903,
            createdAt: daysAgo(9),
            state: 'OPEN',
            statusCheckRollup: [
              { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
              { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
              { __typename: 'StatusContext', state: 'ERROR' },
            ],
          },
        ]),
      ),
    );
    const row = row7(rows);
    expect(row.verdict).toBe('unhealthy');
    expect(row.reason).toContain('stuck');
    expect(row.reason).not.toContain('merge or close');
  });

  test('a 7+ day PR whose checks read pending — running, or an empty rollup — is unhealthy on CI', async () => {
    for (const statusCheckRollup of [
      [{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null }],
      [],
    ]) {
      const rows = verdictOf(
        await healthAt(
          '.',
          withPrs([{ number: 904, createdAt: daysAgo(9), state: 'OPEN', statusCheckRollup }]),
        ),
      );
      const row = row7(rows);
      expect(row.verdict).toBe('unhealthy');
      expect(row.reason).not.toContain('merge or close');
    }
  });

  test('a mixed stuck page answers BOTH groups — merge-or-close and the npm-bump ask together', async () => {
    // The regression: an early return on the first green-stuck PR used to drop the red-stuck
    // PR and its npm-bump ask from the row's filing instructions entirely.
    const rows = verdictOf(
      await healthAt(
        '.',
        withPrs([
          { number: 907, createdAt: daysAgo(9), state: 'OPEN', statusCheckRollup: GREEN_ROLLUP },
          {
            number: 908,
            createdAt: daysAgo(9),
            state: 'OPEN',
            statusCheckRollup: [
              { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
            ],
          },
        ]),
      ),
    );
    const row = row7(rows);
    expect(row.verdict).toBe('unhealthy');
    expect(row.reason).toContain('#907');
    expect(row.reason).toContain('merge or close');
    expect(row.reason).toContain('#908');
    expect(row.reason).toContain('the npm-bump ask applies');
  });

  test('an entry whose state contradicts --state open is no open PR — its createdAt is not an age', async () => {
    const rows = verdictOf(
      await healthAt('.', withPrs([{ number: 905, createdAt: daysAgo(30), state: 'MERGED' }])),
    );
    expect(row7(rows).verdict).toBe('healthy');
  });

  test('an open PR without a readable createdAt is unverdicted, never a filing', async () => {
    const rows = verdictOf(
      await healthAt('.', withPrs([{ number: 906, createdAt: 'not-a-date', state: 'OPEN' }])),
    );
    expect(row7(rows).verdict).toBe('unverdicted');
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
