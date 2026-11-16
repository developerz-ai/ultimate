// One responsibility: a temp directory with ONE owner, who makes it, runs its children, and removes
// it only once they have exited. A `rmSync` racing a child still writing under the tree — git's
// detached `maintenance run --auto` unlinking a lock after `git commit` returned — stopped silently
// and left `HEAD`, `refs/` and `config` behind on CI (run 43546649352; red `main`, `e407c015a`).

// why: Bun has no mkdtemp, no recursive remove and no existence check for a directory.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join, resolve } from 'node:path';
import { finiteCount } from '@ultimat3/core';
import { killTree } from '@ultimat3/scraping/cdp';
import { TempTreeLeftError } from './temp-tree-error';

/** A read or a commit in a temp repository does no work worth 30 s: past it, git has hung. */
export const TEMP_TREE_GIT_TIMEOUT_MS = 30_000;

/**
 * The configuration every git in a tree runs under, as `GIT_CONFIG_*` so it reaches a git the code
 * under test spawns too: none of the background work that outlives a command (auto gc, auto
 * maintenance, fsmonitor), an identity so a commit cannot fail on a bare CI box, no signing.
 */
const GIT_CONFIG: readonly (readonly [string, string])[] = [
  ['maintenance.auto', 'false'],
  ['gc.auto', '0'],
  ['core.fsmonitor', 'false'],
  ['user.name', 'test'],
  ['user.email', 'test@example.com'],
  ['commit.gpgsign', 'false'],
];

/**
 * git steered at the tree and nothing else: an inherited `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`
 * (a hook exports them) unset, discovery stopped at the temp root, no prompt and no optional locks.
 */
export const TEMP_TREE_GIT_ENV: Readonly<Record<string, string | undefined>> = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_CEILING_DIRECTORIES: tmpdir(),
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_COUNT: String(GIT_CONFIG.length),
  ...Object.fromEntries(
    GIT_CONFIG.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${String(index)}`, key],
      [`GIT_CONFIG_VALUE_${String(index)}`, value],
    ]),
  ),
};

/** What `tree.track` needs of a child: its exit, and a way to end one still running. */
export interface TrackedChild {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface TempTreeGitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface TempTree extends AsyncDisposable {
  /** The directory, made empty under the platform temp root. */
  readonly path: string;
  /** Overlay it on `Bun.env` for any child that may run git here — the code under test's too. */
  readonly gitEnv: Readonly<Record<string, string | undefined>>;
  /** git in `cwd` (default `path`), under `gitEnv`, tracked and awaited; the exit is the caller's to read. */
  git(args: readonly string[], options?: { readonly cwd?: string }): Promise<TempTreeGitResult>;
  /**
   * Spawn a child as its own process group (POSIX) and hand it to the tree: `dispose()` ends it
   * with everything it started — a `sh -c` line's grandchild included — and awaits its exit.
   */
  spawn(
    argv: readonly string[],
    options?: TempTreeSpawnOptions,
  ): Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  /**
   * Hand a child spawned elsewhere to the tree: `dispose()` ends it if it still runs, and awaits
   * its exit. Only the child itself: what it started is out of reach — prefer `spawn`.
   */
  track<T extends TrackedChild>(child: T): T;
  /** Await every child, remove the tree, and prove it is gone (`X_TEST_TEMP_TREE_LEFT`). Idempotent. */
  dispose(): Promise<void>;
}

/** `Bun.env` with `overlay` on top, an `undefined` value deleting the key. */
const overlaid = (
  overlay: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const env = new Map(Object.entries(Bun.env));
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) env.delete(key);
    else env.set(key, value);
  }
  return Object.fromEntries(
    [...env].filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
};

/**
 * Where a tree made `inPackage` lives: `<package>/.x/fixtures/`, which the repository's `.x/`
 * ignore rule already covers. A tree there was swept into a commit as `.<name>-fixture-XXXXXX/`.
 */
export const IN_PACKAGE_TEMP_ROOT = '.x/fixtures';

export interface TempTreeOptions {
  /**
   * A package directory: the tree is made under its `IN_PACKAGE_TEMP_ROOT` instead of the platform
   * temp root, for a child that must resolve `@ultimat3/*` from the workspace. Never anywhere else
   * in the checkout (`scripts/temp-tree.ts` refuses an in-repo `mkdtemp`).
   */
  readonly inPackage?: string;
  /** The recursive remove, for a test of the check after it; default `rmSync(…, { recursive, force })`. */
  readonly remove?: (path: string) => void;
}

const removeTree = (path: string): void => rmSync(path, { recursive: true, force: true });

/** What `tree.spawn` takes: the tree's own directory by default, and `Bun.env` under `env`. */
export interface TempTreeSpawnOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdout?: 'pipe' | 'ignore';
  readonly stderr?: 'pipe' | 'ignore';
  /** Default `TEMP_TREE_GIT_TIMEOUT_MS`: a child still running past it is killed by Bun. */
  readonly timeout?: number;
}

/** One child and how it is ended: its whole group, or only itself when spawned elsewhere. */
interface Held {
  readonly child: TrackedChild;
  readonly group: boolean;
}

/** A temp tree named `<prefix><random>`; `await using tree = tempTree('x-')` removes it at scope end. */
export function tempTree(prefix: string, options: TempTreeOptions = {}): TempTree {
  // Absolute, always: git ignores a relative `GIT_CEILING_DIRECTORIES` entry, and a tree inside a
  // package would then answer for the checkout around it.
  const parent =
    options.inPackage === undefined ? tmpdir() : resolve(options.inPackage, IN_PACKAGE_TEMP_ROOT);
  mkdirSync(parent, { recursive: true });
  const path = mkdtempSync(join(parent, prefix));
  // Discovery stops at the tree's own parent: inside a package, git would otherwise find the
  // checkout itself and run there.
  const gitEnv = { ...TEMP_TREE_GIT_ENV, GIT_CEILING_DIRECTORIES: parent };
  const children = new Set<Held>();
  let disposed: Promise<void> | undefined;

  const track = <T extends TrackedChild>(child: T): T => {
    children.add({ child, group: false });
    return child;
  };

  const spawn = (argv: readonly string[], spawnOptions: TempTreeSpawnOptions = {}) => {
    const child = Bun.spawn([...argv], {
      cwd: spawnOptions.cwd ?? path,
      env: overlaid(spawnOptions.env ?? {}),
      stdin: 'ignore',
      stdout: spawnOptions.stdout ?? 'pipe',
      stderr: spawnOptions.stderr ?? 'pipe',
      timeout: finiteCount(
        'tree.spawn',
        'timeout',
        spawnOptions.timeout ?? TEMP_TREE_GIT_TIMEOUT_MS,
        1,
      ),
      // Its own process group on POSIX, so the group is what `dispose()` ends; on Windows
      // `detached` is a console flag, and `taskkill /T` walks the tree instead.
      detached: process.platform !== 'win32',
    }) as Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
    children.add({ child, group: true });
    return child;
  };

  /** End one child — its whole group when the tree spawned it, even after it exited — and await it. */
  const end = async ({ child, group }: Held): Promise<void> => {
    const pid = Reflect.get(child, 'pid');
    if (group && typeof pid === 'number') await killTree(pid);
    else if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited.catch(() => undefined);
  };

  const git = async (
    args: readonly string[],
    options: { readonly cwd?: string } = {},
  ): Promise<TempTreeGitResult> => {
    const child = spawn(['git', ...args], { cwd: options.cwd ?? path, env: gitEnv });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  };

  const remove = async (): Promise<void> => {
    // Pass by pass: a child handed over while an earlier pass waited is ended by the next one.
    while (children.size > 0) {
      const pass = [...children];
      for (const held of pass) children.delete(held);
      await Promise.all(pass.map(end));
    }
    (options.remove ?? removeTree)(path);
    // Bun's recursive remove can stop at an entry that vanished under it and report success.
    if (existsSync(path)) throw new TempTreeLeftError({ path, left: readdirSync(path) });
  };

  // A failed removal is no answer to keep: the next `dispose()` tries again.
  const dispose = (): Promise<void> => {
    disposed ??= remove().catch((error: unknown) => {
      disposed = undefined;
      throw error;
    });
    return disposed;
  };

  return {
    path,
    gitEnv,
    git,
    spawn,
    track,
    dispose,
    [Symbol.asyncDispose]: dispose,
  };
}

/** Trees one file makes and removes together: `make(prefix)` answers a path, `dispose()` all of them. */
export interface TempTrees {
  make(prefix: string): string;
  dispose(): Promise<void>;
}

/**
 * Many trees, one owner — the shape a file with an `afterAll` takes: `const trees = tempTrees();
 * afterAll(() => trees.dispose());`, then `trees.make('x-')` wherever a test needs a directory.
 */
export function tempTrees(options: TempTreeOptions = {}): TempTrees {
  const made: TempTree[] = [];
  return {
    make(prefix) {
      const tree = tempTree(prefix, options);
      made.push(tree);
      return tree.path;
    },
    async dispose() {
      await Promise.all(made.splice(0).map((tree) => tree.dispose()));
    },
  };
}
