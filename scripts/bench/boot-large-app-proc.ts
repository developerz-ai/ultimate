// One timed boot for `boot-large-app.bench.ts`: spawn a server in its own process group, poll a URL
// until it answers 200, and sample the group's resident memory the whole way — wall clock from
// spawn to the first 200, and the peak RSS summed over the group (`x dev` is a supervisor and a
// child). Then the group is stopped and reaped, so the next boot starts from nothing.

import { quoteArg } from '../../packages/cli/src/shell-quote';
import { ScriptError } from '../lib/script-error';
import type { Boot } from './boot-large-app-shape';

export interface BootCommand {
  readonly cmd: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly url: string;
  /** Past it the boot is a hang, not a figure. */
  readonly timeoutMs: number;
}

/** Resident memory of a process group in MiB, summed over its processes — 0 once it is gone. */
export function groupRssMb(pgid: number): number {
  const out = Bun.spawnSync(['ps', '-o', 'rss=', '-g', String(pgid)], { timeout: 5_000 });
  const kib = out.stdout
    .toString()
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  return Math.round(kib.reduce((sum, value) => sum + value, 0) / 1024);
}

/**
 * The URL's status once its whole body arrived, or 0. The body is read inside the same `try`: a
 * read that aborts on the timeout after the headers said 200 is not ready either, and it must not
 * reject past the poll that has a process group to reap.
 */
async function status(url: string): Promise<number> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'manual' });
    await response.arrayBuffer();
    return response.status;
  } catch {
    return 0;
  }
}

/** Whether anything accepts a connection on the URL's port — a server this boot did not start. */
async function portTaken(url: string): Promise<boolean> {
  const target = new URL(url);
  const port = Number(target.port === '' ? 80 : target.port);
  try {
    const socket = await Bun.connect({
      hostname: target.hostname,
      port,
      socket: { data: () => undefined },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * One poll's verdict. A child that has exited is never ready, whatever answers its URL: that 200
 * is another process's, and timing it would publish a stranger's boot.
 */
export function readiness(status: number, exitCode: number | null): 'ready' | 'waiting' | 'exited' {
  if (exitCode !== null) return 'exited';
  return status === 200 ? 'ready' : 'waiting';
}

/** How long a stopped group gets to exit on SIGTERM before SIGKILL. */
const STOP_GRACE_MS = 15_000;

/** SIGTERM the group, wait for the leader, SIGKILL whatever is left of it. */
async function stopGroup(child: Bun.Subprocess, pgid: number): Promise<void> {
  const signal = (name: NodeJS.Signals): void => {
    try {
      process.kill(-pgid, name);
    } catch {
      // The group is already gone: nothing left to signal.
    }
  };
  signal('SIGTERM');
  await Promise.race([child.exited, Bun.sleep(STOP_GRACE_MS)]);
  signal('SIGKILL');
  await child.exited;
}

/**
 * Boot `command`, time it to the first 200 on its URL and sample its memory every 100 ms. A boot
 * that exits, or never answers 200 inside the timeout, is `X_BENCH_RUN_FAILED` with its output's
 * tail — never a figure.
 */
export async function timeBoot(command: BootCommand): Promise<Boot> {
  if (await portTaken(command.url)) {
    throw new ScriptError({
      code: 'X_BENCH_RUN_FAILED',
      cause: `something already listens on ${command.url}, so a 200 there would time a server this bench did not start`,
      fix: `curl -sS -o /dev/null -w '%{http_code}\\n' ${quoteArg(command.url)}   # whatever answers is the listener: stop it, or re-run the bench with another --port`,
    });
  }
  const started = performance.now();
  const child = Bun.spawn([...command.cmd], {
    cwd: command.cwd,
    env: { ...command.env },
    detached: true,
    // A backstop only: the poll below gives up at `timeoutMs` and `stopGroup` reaps the group; this
    // kills the child if that never runs (a `status` that hangs, the bench itself interrupted).
    timeout: command.timeoutMs + STOP_GRACE_MS + 5_000,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output: string[] = [];
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output.push(decoder.decode(chunk));
  };
  void drain(child.stdout);
  void drain(child.stderr);
  let peak = 0;
  let last = 0;
  let toFirst200: number | undefined;
  // The group is reaped however the poll ends: a figure, a timeout, or a throw out of the loop.
  try {
    while (performance.now() - started < command.timeoutMs) {
      peak = Math.max(peak, groupRssMb(child.pid));
      last = await status(command.url);
      const verdict = readiness(last, child.exitCode);
      if (verdict === 'ready') {
        toFirst200 = Math.round(performance.now() - started);
        break;
      }
      if (verdict === 'exited') break;
      await Bun.sleep(100);
    }
    peak = Math.max(peak, groupRssMb(child.pid));
  } finally {
    await stopGroup(child, child.pid);
  }
  if (toFirst200 === undefined) {
    throw new ScriptError({
      code: 'X_BENCH_RUN_FAILED',
      cause: `${command.cmd.join(' ')} answered ${String(last)} on ${command.url}, not 200, within ${String(command.timeoutMs)} ms (exit ${String(child.exitCode)}): ${output.join('').slice(-800)}`,
      // Built as words, never a template: every value is quoted on its own by `quoteArg`.
      fix: [
        'cd',
        quoteArg(command.cwd),
        '&&',
        ...command.cmd.map(quoteArg),
        "  # boot it by hand and read why the cause's URL is not 200",
      ].join(' '),
    });
  }
  return { toFirst200Ms: toFirst200, peakRssMb: peak };
}
