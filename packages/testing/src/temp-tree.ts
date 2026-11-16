// One responsibility: a temp directory with ONE owner, who makes it, runs its children, and removes
// it only once they have exited. A `rmSync` racing a child still writing under the tree — git's
// detached `maintenance run --auto` unlinking a lock after `git commit` returned — stopped silently
// and left `HEAD`, `refs/` and `config` behind on CI (run 43546649352; red `main`, `e407c015a`).

// why: Bun has no mkdtemp, no recursive remove and no existence check for a directory.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
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
  /** Hand a child to the tree: `dispose()` ends it if it still runs, and awaits its exit. */
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

export interface TempTreeOptions {
  /** The recursive remove, for a test of the check after it; default `rmSync(…, { recursive, force })`. */
  readonly remove?: (path: string) => void;
}

const removeTree = (path: string): void => rmSync(path, { recursive: true, force: true });

/** A temp tree named `<prefix><random>`; `await using tree = tempTree('x-')` removes it at scope end. */
export function tempTree(prefix: string, options: TempTreeOptions = {}): TempTree {
  const path = mkdtempSync(join(tmpdir(), prefix));
  const children = new Set<TrackedChild>();
  let disposed: Promise<void> | undefined;

  const track = <T extends TrackedChild>(child: T): T => {
    children.add(child);
    return child;
  };

  const git = async (
    args: readonly string[],
    options: { readonly cwd?: string } = {},
  ): Promise<TempTreeGitResult> => {
    const child = track(
      Bun.spawn(['git', ...args], {
        cwd: options.cwd ?? path,
        env: overlaid(TEMP_TREE_GIT_ENV),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: TEMP_TREE_GIT_TIMEOUT_MS,
      }),
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  };

  const remove = async (): Promise<void> => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.allSettled([...children].map((child) => child.exited));
    children.clear();
    (options.remove ?? removeTree)(path);
    // Bun's recursive remove can stop at an entry that vanished under it and report success.
    if (existsSync(path)) throw new TempTreeLeftError({ path, left: readdirSync(path) });
  };

  const dispose = (): Promise<void> => {
    disposed ??= remove();
    return disposed;
  };

  return {
    path,
    gitEnv: TEMP_TREE_GIT_ENV,
    git,
    track,
    dispose,
    [Symbol.asyncDispose]: dispose,
  };
}
