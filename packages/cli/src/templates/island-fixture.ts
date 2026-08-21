// TEST-ONLY. An app root on disk holding emitted files, with the packages an island imports
// resolvable BY SPECIFIER the way a real app resolves them — so a template that emits
// `import { Button } from '@ultimat3/ui'` is proven by a build that actually resolves it, and not
// by a string assertion that the import is present.

import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GeneratedFile } from './naming';

/** `packages/cli/src/templates` → the repo root, four hops up. */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');

/**
 * INSIDE the checkout, and measured rather than chosen: the identical fixture under `os.tmpdir()`
 * fails every `@ultimat3/*` and every relative import inside it with `Could not resolve`, because
 * `Bun.build`'s resolver is scoped to the project `bun test` was started in and an app root outside
 * it cannot reach its own `node_modules`. `.prerender-fixture` is the same shape for the same
 * reason. The leading dot keeps it out of every `tsc` wildcard include.
 */
const FIXTURE_ROOT = join(REPO_ROOT, 'packages', 'cli', '.island-fixture');

/** The package the fixture lives inside. Linking it would aim a symlink at its own ancestor. */
const SELF = 'cli';

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
    const name = entry.slice(0, entry.indexOf('/'));
    if (name === SELF) continue;
    symlinkSync(join(packages, name), join(scope, name), 'dir');
  }
  // Resolved, never spelled as a path: the installer's layout is its own business and a hardcoded
  // `node_modules/solid-js` is a fixture that breaks on a linker change rather than on a real one.
  symlinkSync(
    dirname(Bun.resolveSync('solid-js/package.json', REPO_ROOT)),
    join(root, 'node_modules', 'solid-js'),
    'dir',
  );
}

/**
 * `Disposable`, so the idiom is `using root = await fixtureAppRoot(label, files)`. `label` is the
 * caller's, and is what keeps two test FILES off one directory: the path is fixed rather than
 * random, because a random one cannot be named in `.gitignore` and a crashed run leaves it behind.
 */
export async function fixtureAppRoot(
  label: string,
  files: readonly GeneratedFile[],
): Promise<FixtureApp> {
  const path = join(FIXTURE_ROOT, label);
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
