// The enforcement half of `scripts/plan-status.ts`: the gate's `unit` step runs every
// `scripts/**/*.test.ts`, so a plan tracker reading `done` fails `bun run verify` with no extra wiring.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no temp-directory native; each case needs a throwaway repo root on disk.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { PLAN_STATUSES, planStatusFindings, statusFindings } from './plan-status';

// The last case reads the real tree, so the file runs on the repo-scan backstop.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const PATH = 'docs/plans/2026/01/01/101-x/status.yml';

const yaml = (status: string, slices: readonly string[] = []): string =>
  [
    'plan: 101-x',
    `status: ${status}        # not_started | in_progress | blocked | complete | superseded`,
    'slices:',
    ...slices.map((s, i) => `  - file: 0${String(i + 1)}-a.md\n    status: ${s}`),
    '',
  ].join('\n');

const codes = (text: string): readonly string[] =>
  statusFindings(PATH, text).map((finding) => finding.code);

describe('one status.yml', () => {
  test.each([...PLAN_STATUSES])('%s is accepted, for the plan and for a slice', (status) => {
    expect(codes(yaml(status, [status]))).toEqual([]);
  });

  test('done — the value the rule exists to refuse — is refused, naming the enum', () => {
    const [finding, ...rest] = statusFindings(PATH, yaml('done'));
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_PLAN_STATUS_INVALID');
    expect(finding?.cause).toContain('"done"');
    expect(finding?.fix).toContain(`in ${PATH}`);
    expect(finding?.fix).toContain('not_started | in_progress | blocked | complete | superseded');
  });

  test('a missing top-level status is refused', () => {
    expect(codes('plan: 101-x\nslices: []\n')).toEqual(['X_PLAN_STATUS_INVALID']);
  });

  test('each slice is held to the enum, and the finding names the slice file', () => {
    const findings = statusFindings(PATH, yaml('in_progress', ['complete', 'finished']));
    expect(findings.map((f) => f.code)).toEqual(['X_PLAN_STATUS_INVALID']);
    expect(findings[0]?.cause).toContain('slices[02-a.md].status');
  });

  test('a slice with no status is refused; flow-style rows are read the same', () => {
    expect(codes('status: complete\nslices:\n  - {file: 01-a.md, tier: 0}\n')).toEqual([
      'X_PLAN_STATUS_INVALID',
    ]);
    expect(codes('status: complete\nslices:\n  - {file: 01-a.md, status: complete}\n')).toEqual([]);
  });

  test('a slices value that is present but not a list is refused rather than skipped', () => {
    for (const slices of ['done', '{file: 01-a.md, status: complete}', '3']) {
      const findings = statusFindings(PATH, `status: complete\nslices: ${slices}\n`);
      expect(findings.map((f) => f.code)).toEqual(['X_PLAN_STATUS_INVALID']);
      expect(findings[0]?.cause).toContain('slices');
      expect(findings[0]?.cause).toContain('not a list');
      expect(findings[0]?.fix).toContain(`in ${PATH}`);
    }
  });

  test('slices absent or empty (`slices:` with nothing under it) is no slices, not an error', () => {
    expect(codes('status: complete\n')).toEqual([]);
    expect(codes('status: complete\nslices:\n')).toEqual([]);
    expect(codes('status: complete\nslices: []\n')).toEqual([]);
  });

  test('YAML that does not parse is refused rather than skipped', () => {
    expect(codes('status: [complete\n')).toEqual(['X_PLAN_STATUS_INVALID']);
  });

  test('a document that is not a mapping is refused', () => {
    expect(codes('- complete\n')).toEqual(['X_PLAN_STATUS_INVALID']);
  });
});

describe('the corpus', () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  test('no status.yml at all is unscanned, never a pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plan-status-'));
    roots.push(root);
    await Bun.write(join(root, 'docs/plans/README.md'), '# plans\n');
    expect((await planStatusFindings(root)).map((f) => f.code)).toEqual([
      'X_PLAN_STATUS_UNSCANNED',
    ]);
  });

  test('every nested status.yml is read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plan-status-'));
    roots.push(root);
    await Bun.write(join(root, 'docs/plans/2026/01/01/101-a/status.yml'), yaml('complete'));
    await Bun.write(join(root, 'docs/plans/2026/02/02/102-b/status.yml'), yaml('done'));
    const findings = await planStatusFindings(root);
    expect(findings.map((f) => f.at)).toEqual(['docs/plans/2026/02/02/102-b/status.yml']);
  });
});

test('every plan tracker in the tree holds a template status', async () => {
  expect(await planStatusFindings(repoRoot())).toEqual([]);
});
