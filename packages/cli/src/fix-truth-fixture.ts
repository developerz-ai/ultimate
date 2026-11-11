// The scaffold `fix-truth.test.ts` breaks, on disk and in git, with `x` on PATH as a real command, so
// a printed `fix:` runs exactly as a reader pastes it. One app per test file; a row leaves it clean.

// why: Bun has no symlink API, temp-directory API, directory listing or recursive remove.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path helpers.
import { delimiter, dirname, join } from 'node:path';
import { planNewApp } from './cmd-new';
import { FIXTURE_APP } from './scaffold-fixture';
import { DIR_LINK, workspaceRoot, workspaceTsc } from './scaffold-typecheck-fixture';

export interface ShellResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface FixtureApp {
  readonly root: string;
  /** A line through a real shell, in the app: quoting, `#` and `&&` as a reader gets them. */
  sh(line: string): Promise<ShellResult>;
  /**
   * The compiler's errors in the app's OWN files, one line each. A diagnostic in a framework source
   * the app's tsconfig reaches through a link is not the row's: it is the checkout's.
   */
  typeErrors(): Promise<readonly string[]>;
  /** Back to the commit: what a row broke, and what its fix wrote, are gone. */
  reset(): Promise<void>;
  remove(): void;
}

const BIN = join(import.meta.dir, 'bin.ts');

/** Git with no ambient identity or hooks: CI has none, and a developer's must not run here. */
export const GIT =
  'git -c user.name=fix-truth -c user.email=fix-truth@example.com -c core.hooksPath=/dev/null';

/** Each workspace under `cwd`, linked by its package name. */
const linkWorkspaces = async (cwd: string, target: string, glob: string): Promise<void> => {
  for await (const manifest of new Bun.Glob(glob).scan({ cwd })) {
    const { name } = (await Bun.file(join(cwd, manifest)).json()) as { name: string };
    const at = join(target, name);
    mkdirSync(dirname(at), { recursive: true });
    symlinkSync(join(cwd, dirname(manifest)), at, DIR_LINK);
  }
};

/**
 * What an install would leave, linked by hand: an install is minutes. Bun's isolated linker keeps
 * each package's dependencies beside it, so third-party imports and bins resolve through the root's
 * and the render package's, and every framework package by its name.
 */
const linkNodeModules = async (root: string): Promise<void> => {
  const framework = workspaceRoot();
  const target = join(root, 'node_modules');
  mkdirSync(target, { recursive: true });
  for (const directory of ['node_modules', 'packages/render/node_modules']) {
    for (const entry of readdirSync(join(framework, directory))) {
      const at = join(target, entry);
      if (['.cache', '.bun', '@ultimat3'].includes(entry) || existsSync(at)) continue;
      symlinkSync(join(framework, directory, entry), at, DIR_LINK);
    }
  }
  await linkWorkspaces(framework, target, 'packages/*/package.json');
  await linkWorkspaces(root, target, '{apps,packages}/*/package.json');
};

/** One printed line's ceiling: a hung fix is a failed row, never a hung gate. */
const SH_TIMEOUT_MS = 170_000;

/** `x new`, committed. No generator on top: the load is the cost here, and each costs one. */
export async function fixtureApp(): Promise<FixtureApp> {
  const root = mkdtempSync(join(tmpdir(), 'x-fix-truth-'));
  for (const file of planNewApp({ name: FIXTURE_APP, example: true })) {
    await Bun.write(join(root, file.path), file.contents);
  }
  await linkNodeModules(root);
  const shims = join(root, '.shims');
  await Bun.write(join(shims, 'x'), `#!/bin/sh\nexec bun ${JSON.stringify(BIN)} "$@"\n`);
  const env = {
    ...Bun.env,
    PATH: `${shims}${delimiter}${Bun.env['PATH'] ?? ''}`,
    // Whatever shell ran the suite, the app under test names its own environment or none.
    ULTIMATE_ENV: 'development',
  };
  const sh = async (line: string): Promise<ShellResult> => {
    // Under the slowest suite's whole budget (`db-fix-truth.job.test.ts`, 180 s): a printed fix
    // that hangs is killed and answers its exit code, rather than holding the worker past it.
    const child = Bun.spawn(['sh', '-c', line], {
      cwd: root,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: SH_TIMEOUT_MS,
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code: await child.exited, stdout, stderr };
  };
  await sh(`chmod +x .shims/x`);
  await Bun.write(join(root, '.gitignore'), 'node_modules\n.shims\n.x\n');
  await sh(`git init -q && ${GIT} add -A && ${GIT} commit -qm scaffold`);
  const tsc = workspaceTsc(workspaceRoot());
  return {
    root,
    sh,
    typeErrors: async () => {
      const { stdout } = await sh(`${JSON.stringify(tsc)} -p . --noEmit --pretty false`);
      return stdout.split('\n').filter((line) => /^(?:apps|packages)\/.*error TS\d+/.test(line));
    },
    reset: async () => {
      await sh(`${GIT} checkout -q -- . && git clean -fdq`);
    },
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
