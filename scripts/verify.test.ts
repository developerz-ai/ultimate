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

/** The `path` of every project a tsconfig references, in declaration order. */
async function tsconfigReferences(path: string): Promise<readonly string[]> {
  const references = field(await readJson(path), 'references');
  if (!Array.isArray(references)) return [];
  return references.flatMap((reference: unknown) => {
    const target = field(reference, 'path');
    return typeof target === 'string' ? [target] : [];
  });
}

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

  // The `typecheck` step is `tsc -b` at the repo root, so a directory the root project does not
  // reference is a directory the gate never reads. `site/` shipped for a year outside it.
  test('the typecheck step reaches site/, not only packages/', async () => {
    const references = await tsconfigReferences(join(repoRoot(), 'tsconfig.json'));
    expect(references).toContain('./site');
  });

  test('site/ is its own bundle graph — no @ultimat3/* path resolves inside it', async () => {
    const config = await readJson(join(repoRoot(), 'site/tsconfig.json'));
    // Axiom 6: the static path never pays for the app path. Emptying the inherited `paths` makes
    // that a build error rather than a comment — `import '@ultimat3/core'` here simply cannot
    // resolve.
    expect(field(field(config, 'compilerOptions'), 'paths')).toEqual({});
  });

  test('this repo has no tier violations and its manifest still generates', async () => {
    const root = repoRoot();
    expect(await tierBoundaries(root)).toEqual([]);
    expect(await frameworkManifest(root)).toEqual([]);
    expect(await errorCodeDocs(root)).toEqual([]);
    expect(await checkRoadmap(root)).toEqual([]);
  });
});
