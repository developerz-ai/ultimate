import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyStepNames } from '@ultimat3/cli';
import { repoRoot } from './lib/run';
// Only the integration assertion below lives here — `checkRoadmap`'s own cases are in
// `scripts/roadmap.test.ts`, next to their source.
import { checkRoadmap } from './roadmap';
import {
  ERROR_REFERENCE,
  errorCodeDocs,
  frameworkManifest,
  HOST_CHECKS,
  tierBoundaries,
} from './verify';

describe('unit · the repo gate is the CLI gate', () => {
  test('the repo adds rules to steps, never steps of its own', () => {
    const names: readonly string[] = verifyStepNames();
    for (const step of Object.keys(HOST_CHECKS)) expect(names).toContain(step);
    expect(Object.keys(HOST_CHECKS)).toEqual(['boundaries', 'errors', 'manifest', 'roadmap']);
  });

  test('the error reference is enforced through the errors step', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-verify-docs-'));
    try {
      await Bun.write(
        join(dir, 'packages/core/src/errors.ts'),
        "export const CODES = ['X_MADE_UP'] as const;\n",
      );
      await Bun.write(join(dir, ERROR_REFERENCE), '# Error codes\n');
      const findings = await errorCodeDocs(dir);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('X_ERROR_CODE_UNDOCUMENTED');
      expect(findings[0]?.at).toBe(ERROR_REFERENCE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the tier table is enforced through the boundaries step', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-verify-host-'));
    try {
      await Bun.write(
        join(dir, 'packages/core/src/bad.ts'),
        "import { dispatch } from '@ultimat3/cli';\nexport const run = dispatch;\n",
      );
      const findings = await tierBoundaries(dir);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('X_BOUNDARY_VIOLATION');
      expect(findings[0]?.at).toBe('packages/core/src/bad.ts');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('this repo has no tier violations and its manifest still generates', async () => {
    const root = repoRoot();
    expect(await tierBoundaries(root)).toEqual([]);
    expect(await frameworkManifest(root)).toEqual([]);
    expect(await errorCodeDocs(root)).toEqual([]);
    expect(await checkRoadmap(root)).toEqual([]);
  });
});
