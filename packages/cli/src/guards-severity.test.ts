// A report-only guard (`severity: 'warning'`) can never turn `boundaries` red: its findings come
// back as warnings, still held to the finding contract. An ordinary guard's hit stays a failure,
// and a report-only guard that breaks the contract is still a finding — failing open is the defect.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API; `mkdtemp`/`rm` own a throwaway app root's lifetime.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { VERIFY_STEPS } from './cmd-verify';
import { exec } from './exec';
import { GUARD_DIR, guardFindings, guardReport } from './guards';

const rule = (severity: string, fix = 'x g action a'): string => `export const guard = {
  summary: 'a rule this app reports',
  ${severity === '' ? '' : `severity: '${severity}',`}
  check: () => [{ code: 'X_APP_RULE', cause: 'apps/web/app/a.ts breaks the rule', fix: '${fix}' }],
};
`;

const withGuards = async (
  files: Readonly<Record<string, string>>,
  body: (root: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'x-guards-severity-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      await Bun.write(join(root, GUARD_DIR, name), contents);
    }
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const boundaries = (root: string) =>
  VERIFY_STEPS.find((step) => step.name === 'boundaries')?.run({ root, runner: exec });

describe('unit · a report-only guard reports, and never fails the step', () => {
  test('a warning guard with a hit leaves boundaries ok, the hit in warnings', async () => {
    await withGuards({ 'advice.ts': rule('warning') }, async (root) => {
      const outcome = await boundaries(root);
      expect(outcome?.ok).toBe(true);
      expect(outcome?.findings ?? []).toEqual([]);
      expect(outcome?.warnings).toEqual([
        'guards/advice.ts: X_APP_RULE apps/web/app/a.ts breaks the rule — fix: x g action a',
      ]);
    });
  });

  test('an ordinary guard with a hit beside it still turns the step red', async () => {
    await withGuards({ 'advice.ts': rule('warning'), 'rule.ts': rule('') }, async (root) => {
      const outcome = await boundaries(root);
      expect(outcome?.ok).toBe(false);
      expect((outcome?.findings ?? []).map((finding) => finding.code)).toEqual(['X_APP_RULE']);
      expect(outcome?.warnings).toHaveLength(1);
      expect(await guardFindings(root)).toHaveLength(1);
    });
  });

  test('a report-only finding that is not one is still a finding', async () => {
    await withGuards({ 'advice.ts': rule('warning', 'check the config') }, async (root) => {
      const report = await guardReport(root);
      expect(report.findings.map((finding) => finding.code)).toEqual(['X_GUARD_FINDING_INVALID']);
      expect(report.warnings).toEqual([]);
    });
  });

  test('a severity that is not one is refused, never read as report-only', async () => {
    await withGuards({ 'advice.ts': rule('info') }, async (root) => {
      const report = await guardReport(root);
      expect(report.findings.map((finding) => finding.code)).toEqual(['X_GUARD_INVALID']);
      expect(report.warnings).toEqual([]);
    });
  });
});
