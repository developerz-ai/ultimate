// The I/O half of `scripts/test-typecheck-gate.ts`: compile `tsconfig.tests.json` — every
// `packages/*/src/**/*.test.ts` and every `packages/*/e2e/**`, the files the shipped package
// configs exclude — and attribute each diagnostic to the package whose tests it belongs to.
// No new dependency: the repo's own `typescript` devDependency is the compiler.

import { join } from 'node:path';
import { run } from './run';

/** The one program that reads test sources. `noEmit` there is what keeps `dist/` out of this. */
export const TESTS_TSCONFIG = 'tsconfig.tests.json';

export interface TestDiagnostic {
  /** Repo-relative, so `at` opens the file. */
  readonly file: string;
  readonly line: number;
  readonly code: number;
  readonly text: string;
}

/**
 * Full path, not the basename `scripts/lib/readme-fences.ts` captures: that check compiles one
 * flat fixture directory and the file name IS the identity, while here the DIRECTORY is what says
 * which package's ratchet a diagnostic counts against.
 */
const DIAGNOSTIC = /^(\S+?)\((\d+),\d+\): error TS(\d+): (.*)$/gm;

export const parseDiagnostics = (output: string): readonly TestDiagnostic[] =>
  [...output.matchAll(DIAGNOSTIC)].map((match) => ({
    file: (match[1] ?? '').replaceAll('\\', '/'),
    line: Number(match[2]),
    code: Number(match[3]),
    text: match[4] ?? '',
  }));

/**
 * The package a diagnostic belongs to, or `undefined` for a file outside `packages/`. Read off the
 * path rather than off the tsconfig, because a diagnostic can land in a file the tests IMPORT —
 * and one in `packages/entity/src/repo.ts` is entity's to answer for either way.
 */
export const packageOf = (file: string): string | undefined => {
  const parts = file.split('packages/');
  const tail = parts.length > 1 ? parts[parts.length - 1] : undefined;
  const name = tail?.split('/')[0];
  return name === undefined || name.length === 0 ? undefined : name;
};

export const countByPackage = (
  diagnostics: readonly TestDiagnostic[],
): Readonly<Record<string, number>> => {
  const counts: Record<string, number> = {};
  for (const diagnostic of diagnostics) {
    const pkg = packageOf(diagnostic.file);
    if (pkg === undefined) continue;
    counts[pkg] = (counts[pkg] ?? 0) + 1;
  }
  return counts;
};

export interface TestTypecheckRun {
  readonly diagnostics: readonly TestDiagnostic[];
  readonly counts: Readonly<Record<string, number>>;
  /** Non-empty when `tsc` itself could not run — a missing binary, a config it refused. */
  readonly failure: string | undefined;
}

/**
 * Compile and attribute. The one impure step.
 *
 * A non-zero exit with nothing this can attribute is `tsc` refusing to run (TS18003 — no inputs, a
 * missing binary, a config error), and reporting that as "every test typechecks" is the false
 * green this whole check exists to remove.
 */
export async function runTestTypecheck(root: string): Promise<TestTypecheckRun> {
  const result = await run(
    [join(root, 'node_modules/.bin/tsc'), '--noEmit', '-p', join(root, TESTS_TSCONFIG)],
    { cwd: root },
  ).catch((cause: unknown) => ({
    // A compiler that will not SPAWN — no `bun install` yet — throws out of `Bun.spawn`, and an
    // uncaught throw here takes the whole `manifest` step down with a stack instead of a finding.
    ok: false,
    output: `node_modules/.bin/tsc could not be started: ${cause instanceof Error ? cause.message : 'unknown failure'}`,
  }));
  const diagnostics = parseDiagnostics(result.output);
  return {
    diagnostics,
    counts: countByPackage(diagnostics),
    failure: result.ok || diagnostics.length > 0 ? undefined : result.output.slice(0, 400),
  };
}
