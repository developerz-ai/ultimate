// The orchestrator over injected readers, its jsonDocument stderr-noise scan, the release-tag
// row's run evidence, and one real spawn with nothing on PATH — a row the script cannot read must
// refuse the whole answer. No network, no real checkout: the pure rules behind the verdicts are
// pinned here too, one row at a time through the same injected readers. Row 7's activity and
// checks cases live in `health-dependabot.test.ts`: one row's world is that file's subject.

import { describe, expect, test } from 'bun:test';
import type { HealthOverrides } from './health';
import {
  CI_ARGS,
  healthAt,
  jsonDocument,
  ROW_COMMANDS,
  TAG_RUN_ARGS,
  TAG_RUN_FIELDS,
} from './health';
import type { RowVerdict } from './lib/health-rule';
import { ROW_IDS } from './lib/health-rule';
import type { ScriptResult } from './lib/log';
import { AWAITING_TAG_COMMAND } from './lib/release-due-rule';

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

describe('unit · health · row 4 asks for the run evidence, not a bare status', () => {
  // The row's filing quotes the run: its id, url, title, the commit it ran at and its creation
  // time. A query that returned only a status could not say WHICH run failed — so the field list is
  // pinned here field by field. `RUN` is a release-tag.yml run as gh names it: `databaseId`,
  // `displayTitle`.
  const URL = 'https://github.com/ultimate/ultimate/actions/runs/4242';
  const FIELDS = 'status,conclusion,databaseId,displayTitle,headSha,url,createdAt';
  const RUN = {
    databaseId: 4242,
    status: 'completed',
    conclusion: 'success',
    displayTitle: 'Tag v3.1.0',
    headSha: SHA,
    url: URL,
    createdAt: '2026-10-23T09:00:00Z',
  };
  /** Row 4's verdict over a list of runs, read the way the brief reads it. */
  const row4 = async (runs: readonly unknown[]): Promise<RowVerdict> => {
    const rows = verdictOf(
      await healthAt('.', { ...healthyReaders, 'tag-runs-ended-well': async () => ({ runs }) }),
    );
    const row = rows.find((one) => one.row === 'tag-runs-ended-well');
    if (row === undefined) return expect.unreachable('the tag-runs row is always answered');
    return row;
  };

  /** The filing evidence every ended-badly run's verdict must carry. */
  const expectFilingEvidence = (row: RowVerdict): void => {
    expect(row.id).toBe(4242);
    expect(row.url).toBe(URL);
    expect(row.title).toBe('Tag v3.1.0');
    expect(row.createdAt).toBe('2026-10-23T09:00:00Z');
    expect(row.headSha).toBe(SHA);
    expect(row.status).toBe('completed');
  };

  test('the row runs and names the whole command, field list and all', async () => {
    expect(TAG_RUN_FIELDS).toBe(FIELDS);
    expect(TAG_RUN_ARGS.join(' ')).toBe(
      `run list --workflow release-tag.yml --limit 5 --json ${FIELDS}`,
    );
    // The command in the finding IS the command the reader ran, so a re-run is the same query.
    const result = await healthAt('.', {
      ...healthyReaders,
      'tag-runs-ended-well': async () => ({ runs: undefined }),
    });
    expect(result.ok).toBe(false);
    expect(result.findings?.[0]?.cause).toContain(
      `gh run list --workflow release-tag.yml --limit 5 --json ${FIELDS}`,
    );
  });

  test('row 4 runs the SAME query the awaiting_tag watch command is, verbatim', () => {
    // ONE canonical release-tag run query, mirrored verbatim: the health row's own command string
    // and the argv its reader spawns are both the release-due rule's watch command. Two constants
    // that merely happen to be equal would drift apart the day either is edited, and the drift
    // would be invisible — the row would quietly ask for less than the ask quotes.
    expect(ROW_COMMANDS['tag-runs-ended-well']).toBe(AWAITING_TAG_COMMAND);
    expect(['gh', ...TAG_RUN_ARGS].join(' ')).toBe(AWAITING_TAG_COMMAND);
    // And the field list the command carries is the one the rule emits, field for field.
    expect(AWAITING_TAG_COMMAND).toBe(
      `gh run list --workflow release-tag.yml --limit 5 --json ${FIELDS}`,
    );
  });

  test('a completed failure is unhealthy, and the verdict carries that run’s filing evidence', async () => {
    const row = await row4([{ ...RUN, conclusion: 'failure' }]);
    expect(row.verdict).toBe('unhealthy');
    expect(row.conclusion).toBe('failure');
    expectFilingEvidence(row);
  });

  test('a cancelled run is unhealthy, and its verdict carries the same filing evidence', async () => {
    const row = await row4([{ ...RUN, conclusion: 'cancelled' }]);
    expect(row.verdict).toBe('unhealthy');
    expect(row.conclusion).toBe('cancelled');
    expectFilingEvidence(row);
  });

  test('a timed-out run is unhealthy, and its verdict carries the same filing evidence', async () => {
    const row = await row4([{ ...RUN, conclusion: 'timed_out' }]);
    expect(row.verdict).toBe('unhealthy');
    expect(row.conclusion).toBe('timed_out');
    expectFilingEvidence(row);
  });

  test('a queued run is unverdicted — a re-run, never a failure filing — with its evidence kept', async () => {
    // Queued on the `release-tag` concurrency group: the run has no completion verdict yet, so
    // the row has none either, and the ask is not filed against a run that never ran — whatever
    // conclusion it carries, a run that has not completed has no verdict to file.
    const row = await row4([{ ...RUN, status: 'queued', conclusion: 'failure' }]);
    expect(row.verdict).toBe('unverdicted');
    expect(row.status).toBe('queued');
    expect(row.conclusion).toBeNull();
    expect(row.id).toBe(4242);
    expect(row.url).toBe(URL);
    expect(row.title).toBe('Tag v3.1.0');
    expect(row.headSha).toBe(SHA);
    expect(row.createdAt).toBe('2026-10-23T09:00:00Z');
  });

  test('a queued run beside a completed failure still files the failure', async () => {
    // The queued run is not the failed run's excuse: the failure that DID complete is the filing.
    const row = await row4([
      { ...RUN, status: 'queued', conclusion: 'failure' },
      { ...RUN, conclusion: 'failure', databaseId: 4243 },
    ]);
    expect(row.verdict).toBe('unhealthy');
    expect(row.id).toBe(4243);
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
