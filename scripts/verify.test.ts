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

const readJson = async (path: string): Promise<unknown> => Bun.file(path).json();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One key off a parsed tsconfig, checked rather than cast — the file is data, not a type. */
const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

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

  test('a documented code no package registers fails the same step', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-verify-registry-'));
    try {
      await Bun.write(join(dir, ERROR_REFERENCE), '# Error codes\n\n| `X_GHOST` | means |\n');
      const findings = await errorCodeDocs(dir);
      expect(findings.map((finding) => finding.code)).toEqual(['X_ERROR_CODE_UNREGISTERED']);
      expect(findings[0]?.cause).toContain('X_GHOST');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * `scripts/` never ships, so no package may own `X_ROADMAP_STATUS_MISSING` — and demanding a
   * registration for it would push a contributor-only code into every generated app. The host
   * scans its own scripts instead, and this is the assertion that the seam actually engages.
   */
  test('a code only this repo’s gate scripts declare needs no package registration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-verify-host-codes-'));
    try {
      await Bun.write(
        join(dir, 'scripts/thing.ts'),
        "export const f = { code: 'X_HOST_ONLY', fix: 'bun run verify' };\n",
      );
      await Bun.write(join(dir, ERROR_REFERENCE), '# Error codes\n\n| `X_HOST_ONLY` | means |\n');
      expect(await errorCodeDocs(dir)).toEqual([]);
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

  // Bun's runtime reads the tsconfig at the CWD to transpile JSX, and at the repo root that is
  // this file — a solution-style config that carries no compilerOptions of its own unless it is
  // told to. Without these two keys every `.tsx` in the repo transpiles against the React
  // automatic runtime, which is not installed, so `bun test` at the root cannot import a single
  // component. One JSX flavour, declared where the runtime looks for it.
  test('the root tsconfig tells the runtime which JSX runtime this repo uses', async () => {
    const options = field(await readJson(join(repoRoot(), 'tsconfig.json')), 'compilerOptions');
    expect(field(options, 'jsx')).toBe('preserve');
    expect(field(options, 'jsxImportSource')).toBe('solid-js');
  });

  test('this repo has no tier violations and its manifest still generates', async () => {
    const root = repoRoot();
    expect(await tierBoundaries(root)).toEqual([]);
    expect(await frameworkManifest(root)).toEqual([]);
    expect(await errorCodeDocs(root)).toEqual([]);
    expect(await checkRoadmap(root)).toEqual([]);
  });
});
