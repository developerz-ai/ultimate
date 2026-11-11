// The one way a root script fetches from `origin`: `--depth=1` only into a clone that is ALREADY
// shallow (CI's checkout), a plain fetch everywhere else. A depth fetch into a full clone writes
// `.git/shallow`, and the developer's next `git pull` refuses "unrelated histories".

import type { RunResult } from './run';
import { run } from './run';

/** How a fetch is spawned: `run`'s shape, so a test can record or fake it. */
export type GitRunner = (
  command: readonly string[],
  options: { readonly cwd: string },
) => Promise<RunResult>;

/** Whether `root` is a shallow clone; a git that cannot say counts as full, the safe answer. */
export async function isShallow(root: string, runner: GitRunner = run): Promise<boolean> {
  const asked = await runner(['git', 'rev-parse', '--is-shallow-repository'], { cwd: root });
  return asked.ok && asked.output.trim() === 'true';
}

/** `git fetch <args>`, at depth 1 only when `root` is already shallow. */
export async function fetchFromOrigin(
  root: string,
  args: readonly string[],
  runner: GitRunner = run,
): Promise<RunResult> {
  const depth = (await isShallow(root, runner)) ? ['--depth=1'] : [];
  return runner(['git', 'fetch', ...depth, ...args], { cwd: root });
}
