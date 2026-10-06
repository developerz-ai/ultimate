// TEST-ONLY. An app root on disk holding emitted files, with the packages an island imports
// resolvable BY SPECIFIER the way a real app resolves them — so a template that emits
// `import { Button } from '@ultimat3/ui'` is proven by a build that actually resolves it, and not
// by a string assertion that the import is present.

// `node:` by necessity, and SYNC by necessity: `[Symbol.dispose]` cannot await, so the teardown
// half has to be synchronous — and Bun ships neither a path API nor a `symlink`.
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { processRoot } from '../process-root-fixture';
import { DIR_LINK } from '../scaffold-typecheck-fixture';
import type { GeneratedFile } from './naming';

/** `packages/cli/src/templates` → the repo root, four hops up. */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');

/**
 * INSIDE the checkout, and measured rather than chosen: the identical fixture under `os.tmpdir()`
 * fails every `@ultimat3/*` and every relative import inside it with `Could not resolve`, because
 * `Bun.build`'s resolver is scoped to the project `bun test` was started in and an app root outside
 * it cannot reach its own `node_modules`. `.prerender-fixture` is the same shape for the same
 * reason. The leading dot keeps it out of every `tsc` wildcard include. Each label is a base, and
 * the root under it is this PROCESS's (`processRoot`): two runs of one file share the checkout.
 */
const fixtureRoot = (label: string): string =>
  processRoot(join(REPO_ROOT, 'packages', 'cli', '.island-fixture', label));

/** The package the fixture lives inside. Linking it would aim a symlink at its own ancestor. */
const SELF = 'cli';

/**
 * `<dir>/package.json` → `<dir>`, from either separator: Windows' glob answers `ui\package.json`,
 * where `indexOf('/')` is -1 and the slice cut the name to `ui\package.jso`.
 */
export const packageDirOf = (entry: string): string => entry.split(/[\\/]/)[0] ?? entry;

export interface FixtureApp extends Disposable {
  /** Absolute path of the app root — what `buildIslands` globs from. */
  readonly path: string;
}

/**
 * Symlinks rather than a `bun install`: the emitted island must resolve THIS working copy of
 * `@ultimat3/ui`, and an install in a fixture directory would fetch the registry's last release
 * and quietly prove nothing about the change under test. Every workspace is linked, not a chosen
 * few — a template that grows an import should build, not fail on a list nobody updated.
 */
function linkDependencies(root: string): void {
  const scope = join(root, 'node_modules', '@ultimat3');
  mkdirSync(scope, { recursive: true });
  const packages = join(REPO_ROOT, 'packages');
  for (const entry of new Bun.Glob('*/package.json').scanSync({ cwd: packages })) {
    const name = packageDirOf(entry);
    if (name === SELF) continue;
    symlinkSync(join(packages, name), join(scope, name), DIR_LINK);
  }
  // Resolved, never spelled as a path: the installer's layout is its own business and a hardcoded
  // `node_modules/solid-js` is a fixture that breaks on a linker change rather than on a real one.
  symlinkSync(
    dirname(Bun.resolveSync('solid-js/package.json', REPO_ROOT)),
    join(root, 'node_modules', 'solid-js'),
    DIR_LINK,
  );
}

/**
 * `Disposable`, so the idiom is `using root = await fixtureAppRoot(label, files)`. `label` is the
 * caller's, and is what keeps two test FILES off one directory; the pid beneath it keeps two
 * PROCESSES off one. Never random: `.island-fixture/` is what `.gitignore` names, and a crashed
 * run's root is reaped by the next run under that label, once its pid is gone.
 */
export async function fixtureAppRoot(
  label: string,
  files: readonly GeneratedFile[],
): Promise<FixtureApp> {
  const path = fixtureRoot(label);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  linkDependencies(path);
  for (const file of files) await Bun.write(join(path, file.path), String(file.contents));
  return {
    path,
    [Symbol.dispose]: (): void => {
      rmSync(path, { recursive: true, force: true });
    },
  };
}
