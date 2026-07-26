// The single subprocess boundary for the root scripts. One implementation, so every script times,
// captures and reports a command the same way.

export interface RunResult {
  readonly command: readonly string[];
  readonly code: number;
  readonly ok: boolean;
  readonly output: string;
  readonly durationMs: number;
}

export async function run(
  command: readonly string[],
  options: { readonly cwd: string } = { cwd: process.cwd() },
): Promise<RunResult> {
  const started = performance.now();
  const [head, ...rest] = command;
  if (head === undefined) throw new RangeError('run() needs a command');
  const proc = Bun.spawn([head, ...rest], {
    cwd: options.cwd,
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
    output: [stdout, stderr]
      .filter((part) => part.trim().length > 0)
      .join('\n')
      .trimEnd(),
    durationMs: Math.round(performance.now() - started),
  };
}

export const repoRoot = (): string => new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
