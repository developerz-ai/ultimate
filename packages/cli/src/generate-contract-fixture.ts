// A generator's output held to the app's own first run, the work every `generate-*.contract` file
// shares: a fresh `x new` scaffold, one `x g` through the CLI, then the real `tsc`, the app's Biome
// and its generated tests. One file per shape, so test workers run the shapes side by side.

// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { writeNewApp } from './cmd-new';
import { dispatch } from './dispatch';
import { exec } from './exec';
import { linkWorkspace } from './generate-sign-in-fixture';
import { formatDiagnostics, typecheckScaffold, workspaceRoot } from './scaffold-typecheck-fixture';
import type { GeneratedFile } from './templates';

const APP = 'probe';

export interface Generated {
  /** The scaffold the generator wrote into, left on disk for the first run. */
  readonly root: string;
  readonly code: number;
  readonly out: string;
  /** Every file on disk after the generator, as `typecheckScaffold` takes them. */
  readonly files: readonly GeneratedFile[];
}

/** A unique scaffold per call (`mkdtemp`): files of one run never share a directory. */
export async function generated(argv: readonly string[], prefix: string): Promise<Generated> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await writeNewApp(root, { name: APP, example: true });
  const out: string[] = [];
  const code = await dispatch({
    argv: ['g', ...argv, '--json'],
    cwd: root,
    env: {},
    bunVersion: Bun.version,
    write: (line) => out.push(line),
  });
  const files: GeneratedFile[] = [];
  for await (const path of new Bun.Glob('**/*').scan({ cwd: root, dot: true })) {
    files.push({ path, contents: await Bun.file(join(root, path)).bytes() });
  }
  return { root, code, out: out.join('\n'), files };
}

export interface FirstRun {
  /** `tsc`'s diagnostics, formatted: `''` is a clean compile. */
  readonly diagnostics: string;
  /** Biome's stdout and stderr together. */
  readonly lint: string;
  /** The generated tests' stdout and stderr, and their exit code. */
  readonly tests: { readonly code: number; readonly output: string };
}

/**
 * The three checks, the compile beside the tests: `tsc` reads its own sandbox copy of `files`
 * (`typecheckScaffold`), so it shares nothing with the scaffold the tests run in, and the slower of
 * the two is the wall time instead of their sum. Biome runs first, before a test can write a file.
 */
export async function firstRun(app: Generated, testPaths: readonly string[]): Promise<FirstRun> {
  const biome = await exec(
    [join(workspaceRoot(), 'node_modules/.bin/biome'), 'check', 'apps/web', 'app.config.ts'],
    { cwd: app.root },
  );
  const [report, tests] = await Promise.all([
    typecheckScaffold({ files: app.files, app: APP }),
    // Running needs the packages by name: `tsc` resolves through its overlay, Bun through these.
    linkWorkspace(app.root).then(() =>
      exec([process.execPath, 'test', ...testPaths], {
        cwd: app.root,
        env: { NODE_ENV: 'test' },
      }),
    ),
  ]);
  return {
    diagnostics: formatDiagnostics(report.diagnostics),
    lint: `${biome.stdout}${biome.stderr}`,
    tests: { code: tests.code, output: `${tests.stdout}\n${tests.stderr}` },
  };
}

/** The scaffold gone: `typecheckScaffold` already removed its own sandbox. */
export const removeGenerated = (app: Generated): Promise<void> =>
  rm(app.root, { recursive: true, force: true });
