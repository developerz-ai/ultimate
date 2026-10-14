// Every subprocess `scripts/release-due.ts` and its tests start: bounded in time, never reading
// stdin, and git made non-interactive — so no state of the machine can turn a read into a hang.
//
// Why its own spawn and not `lib/run.ts`: `run()` has no deadline and waits for EOF on the child's
// pipes, and a pipe stays open as long as ANY process holds it — a git that detaches background
// maintenance, a credential helper, a pager. `release-due.test.ts` once sat in a CI shard until the
// step deadline killed it (PR #779, `gate (unit-2)`), with no test reported. Here the whole call,
// pipes included, is raced against the deadline, and the child is killed when it loses.

export const SPAWN_TIMEOUT_MS = 30_000;

export interface BoundedResult {
  readonly ok: boolean;
  readonly code: number | null;
  readonly output: string;
  readonly timedOut: boolean;
}

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

/** Run `command` to completion or `timeoutMs`, whichever is first; never throws on the child. */
export async function bounded(
  command: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: Record<string, string | undefined>;
    readonly timeoutMs?: number;
  },
): Promise<BoundedResult> {
  const timeoutMs = options.timeoutMs ?? SPAWN_TIMEOUT_MS;
  const proc = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env ?? Bun.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  const done = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), timeoutMs);
  });
  const settled = await Promise.race([done, late]);
  clearTimeout(timer);
  if (settled === 'late') {
    proc.kill('SIGKILL');
    return {
      ok: false,
      code: null,
      output: `${command.join(' ')} did not finish within ${timeoutMs} ms and was killed`,
      timedOut: true,
    };
  }
  const [stdout, stderr, code] = settled;
  return {
    ok: code === 0,
    code,
    output: [stdout, stderr]
      .map((part) => part.trimEnd())
      .filter((part) => part.length > 0)
      .join('\n'),
    timedOut: false,
  };
}

/** A read-only git command in `cwd`, bounded and non-interactive. */
export const git = (
  args: readonly string[],
  cwd: string,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<BoundedResult> =>
  bounded(['git', ...GIT_QUIET, ...args], { cwd, env: gitEnv(extraEnv) });
