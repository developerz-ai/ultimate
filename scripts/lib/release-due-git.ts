// The git `scripts/release-due.ts` and its tests run: non-interactive, with none of the background
// work that outlives a command while holding its pipes, and on a deadline far shorter than the
// default — a read-only git that takes 30 s has hung. The spawn itself is `lib/run.ts`'s, the one
// boundary (it was a second, bounded copy here until #780 gave `run()` the deadline).

import type { RunResult } from './run';
import { run } from './run';

/** A read-only git's deadline, well under `DEFAULT_RUN_TIMEOUT_MS`: none of these does work. */
export const GIT_TIMEOUT_MS = 30_000;

/** The environment minus every `GIT_*` a hook or a caller exported: GIT_DIR would redirect git. */
const withoutGit = (env: Readonly<Record<string, string | undefined>>) =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));

/**
 * git that cannot wait on a person or leave a process behind: no prompt, no pager, no editor, no
 * optional locks, and none of the background work (auto gc, auto maintenance, fsmonitor) that
 * outlives the command while holding its pipes.
 */
export const gitEnv = (
  extra: Readonly<Record<string, string>> = {},
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): Record<string, string | undefined> => ({
  ...withoutGit(env),
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  GIT_EDITOR: 'true',
  GIT_OPTIONAL_LOCKS: '0',
  ...extra,
});

export const GIT_QUIET = [
  '--no-pager',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
  '-c',
  'core.fsmonitor=false',
] as const;

/** A read-only git command in `cwd`, bounded and non-interactive. */
export const git = (
  args: readonly string[],
  cwd: string,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<RunResult> =>
  run(['git', ...GIT_QUIET, ...args], { cwd, env: gitEnv(extraEnv), timeoutMs: GIT_TIMEOUT_MS });
