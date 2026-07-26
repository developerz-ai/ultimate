// The single subprocess boundary for the CLI. Every shell-out goes through `exec` so timing,
// output capture and the "command not found" failure mode are identical everywhere, and so a
// test can substitute a fake runner instead of spawning anything.

export interface ExecResult {
  readonly command: readonly string[];
  readonly code: number;
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface ExecOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

export type Runner = (command: readonly string[], options: ExecOptions) => Promise<ExecResult>;

/** performance.now(), not Date.now(): the test preload freezes the wall clock on purpose. */
const now = (): number => performance.now();

export const exec: Runner = async (command, options) => {
  const started = now();
  const [head, ...rest] = command;
  if (head === undefined) throw new RangeError('exec requires at least one argument');
  const proc = Bun.spawn([head, ...rest], {
    cwd: options.cwd,
    env: options.env === undefined ? Bun.env : { ...Bun.env, ...options.env },
    stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    command,
    code,
    ok: code === 0,
    stdout,
    stderr,
    durationMs: Math.round(now() - started),
  };
};

/** Merged stream, trimmed — what a human wants to read under a failed step. */
export const execOutput = (result: ExecResult): string =>
  [result.stdout, result.stderr]
    .filter((part) => part.trim().length > 0)
    .join('\n')
    .trimEnd();
