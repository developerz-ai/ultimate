import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyStepNames } from '@ultimat3/cli';
import { repoRoot, run } from './lib/run';
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

  // Both tests exist because either alone lies. The one above pins the mechanism — `paths` is the
  // knob, and an edit that refills it should be caught by name. This one pins the effect: emptying
  // `paths` does not by itself make `@ultimat3/core` unresolvable, since node resolution would
  // still walk up to a linked workspace package in `node_modules`. Only a real compile answers.
  test('site/ is its own bundle graph — a real tsc cannot resolve @ultimat3/core inside it', async () => {
    // The probe sits under `site/` so resolution walks the same ancestor directories a real site
    // source does. The `.` prefix keeps it out of site/tsconfig.json's own `**/*.ts` include
    // while it exists — TypeScript's wildcards skip dot-directories.
    const dir = await mkdtemp(join(repoRoot(), 'site', '.probe-'));
    try {
      await Bun.write(join(dir, 'probe.ts'), "import '@ultimat3/core';\n");
      await Bun.write(
        join(dir, 'tsconfig.json'),
        `${JSON.stringify(
          {
            extends: '../tsconfig.json',
            compilerOptions: { noEmit: true },
            files: ['./probe.ts'],
            include: [],
          },
          null,
          2,
        )}\n`,
      );
      const config = join(dir, 'tsconfig.json');
      const result = await run(['bunx', 'tsc', '-p', config, '--pretty', 'false'], {
        cwd: repoRoot(),
      });
      expect(result.ok).toBe(false);
      // Asserted in two fragments rather than one sentence: tsc words a side-effect import's
      // failure (TS2882) differently from a named one (TS2307), and which sentence this tsc
      // build prints is not what the test is about — that the specifier does not resolve is.
      expect(result.output).toContain('Cannot find module');
      expect(result.output).toContain("'@ultimat3/core'");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('this repo has no tier violations and its manifest still generates', async () => {
    const root = repoRoot();
    expect(await tierBoundaries(root)).toEqual([]);
    expect(await frameworkManifest(root)).toEqual([]);
    expect(await errorCodeDocs(root)).toEqual([]);
    expect(await checkRoadmap(root)).toEqual([]);
  });
});
