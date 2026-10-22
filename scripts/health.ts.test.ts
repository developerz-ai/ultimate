// The orchestrator over injected readers, its jsonDocument stderr-noise scan, and one real spawn
// with nothing on PATH — a row the script cannot read must refuse the whole answer. No network, no
// real checkout: the pure rules these readers feed are pinned beside them, in health-rule.test.ts.

import { describe, expect, test } from 'bun:test';
import type { HealthOverrides } from './health';
import { healthAt, jsonDocument } from './health';
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
    expect(result.findings?.[0]?.code).toBe('X_RELEASE_TAG_UNREACHABLE');
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
    const result = await healthAt('.', {
      ...healthyReaders,
      'tag-runs-ended-well': async () => ({ runs: undefined }),
    });
    expect(result.ok).toBe(false);
    expect(result.findings?.[0]?.code).toBe('X_HEALTH_ROW_UNREADABLE');
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
