// `x stop` — ends this checkout's `x dev`, and returns only once the next `x dev` can boot. The
// lock is the whole authority: the pid `.x/dev.lock` names is the only process signalled, never
// one found by port or by name, so agents sharing a box cannot end each other's servers.

import { drainDeadlineMs, renderThrowable, stringField, UltimateError } from '@ultimat3/core';
import { parseDuration } from '@ultimat3/time';
import { requireAppRoot } from './app-root';
import { stopSpec } from './cmd-stop-spec';
import type { CliCommand, CommandContext } from './command';
import { clearLock, isProcessAlive, liveDevLock, lockPath, parseLock, reusedPid } from './dev-lock';
import { BadFlagError } from './errors';
import { MIN_RELEASE_MS } from './hold';
import { msg } from './messages';
import type { CommandResult } from './output';
import { flagString } from './parse';
import { resolveServices } from './runtime-bindings';

/** How often the wait asks whether the pid has left. */
const POLL_MS = 50;

/** The child's own hard exit (`devHardExitMs`) plus margin, so its self-kill lands inside the wait. */
export const defaultStopTimeoutMs = (): number => drainDeadlineMs() + MIN_RELEASE_MS + 5_000;

/** The pid belongs to another user: SIGTERM is refused with EPERM, so nothing was stopped. */
export class DevStopDeniedError extends UltimateError {
  constructor(input: { readonly pid: number }) {
    super({
      code: 'X_DEV_STOP_DENIED',
      cause: `x stop may not signal pid ${String(input.pid)}, the x dev this checkout's lock names: another user owns it (EPERM)`,
      fix: `ps -o user= -p ${String(input.pid)}   # then, as that user: x stop --json`,
      meta: { pid: input.pid },
    });
  }
}

/** The pid outlived the wait. Its lock stays: the process still holds the directory. */
export class DevStopTimeoutError extends UltimateError {
  constructor(input: { readonly pid: number; readonly waitedMs: number }) {
    super({
      code: 'X_DEV_STOP_TIMEOUT',
      cause: `x stop sent SIGTERM to pid ${String(input.pid)}, the x dev this checkout's lock names, and it was still running ${String(input.waitedMs)}ms later — a drain past its deadline, or a process that ignores SIGTERM`,
      // A hard kill leaves the lock behind, and `preflight` clears a lock whose pid is dead.
      fix: `kill -9 ${String(input.pid)}   # then: x dev --json`,
      meta: { pid: input.pid, waitedMs: input.waitedMs },
    });
  }
}

export type StopResult =
  /** `stale`: the lock names a live pid that is not the process that wrote it (a reused pid). */
  | { readonly stopped: false; readonly stale?: true }
  | {
      readonly stopped: true;
      readonly pid: number;
      readonly port: number;
      readonly waitedMs: number;
      /** False on Windows, where `kill` is TerminateProcess and no drain runs. */
      readonly drained: boolean;
    };

export interface StopInput {
  readonly stateDir: string;
  readonly timeoutMs: number;
  /** Test seams: the defaults are this process's platform, `process.kill` and signal 0. */
  readonly platform?: NodeJS.Platform;
  readonly kill?: (pid: number) => void;
  readonly alive?: (pid: number) => boolean;
}

/** SIGTERM, with the one refusal a reader can act on coded; a pid already gone is no refusal. */
function signal(pid: number, kill: (pid: number) => void): void {
  try {
    kill(pid);
  } catch (error) {
    // `stringField`, never a cast: the rule `dev-lock.ts`'s `isProcessAlive` states.
    const code = stringField(error, 'code');
    if (code === 'EPERM') throw new DevStopDeniedError({ pid });
    if (code !== 'ESRCH') {
      throw new UltimateError({
        code: 'X_CLI_UNEXPECTED',
        cause: `x stop could not signal pid ${String(pid)}: ${renderThrowable(error)}`,
        fix: 'x doctor --json',
      });
    }
  }
}

/** Whether the lock on disk still names `pid`: a drain removes it before the process exits. */
const lockNames = async (stateDir: string, pid: number): Promise<boolean> => {
  const file = Bun.file(lockPath(stateDir));
  if (!(await file.exists())) return false;
  return parseLock(await file.text())?.pid === pid;
};

/**
 * Signal the lock's holder and wait for both facts the next boot reads: the pid gone and the lock
 * no longer naming it. A dead pid whose lock survived was terminated without a drain (Windows, or a
 * crash mid-drain), and its lock is cleared here so `x stop` returning means `x dev` boots.
 * No live holder is not a failure: a stale lock is left for `preflight`, which owns that clear.
 */
export async function stopDev(input: StopInput): Promise<StopResult> {
  const alive = input.alive ?? isProcessAlive;
  const lock = liveDevLock(input.stateDir);
  if (lock === undefined || !alive(lock.pid)) return { stopped: false };
  // A pid alone is not the holder: a kill -9 leaves the lock and the kernel reuses the number.
  // Nothing is signalled and nothing cleared; the next `x dev`'s preflight clears it (`reusedPid`).
  if (await reusedPid(lock)) return { stopped: false, stale: true };
  const windows = (input.platform ?? process.platform) === 'win32';
  const started = performance.now();
  signal(lock.pid, input.kill ?? ((pid: number) => process.kill(pid, 'SIGTERM')));
  const waited = (): number => Math.round(performance.now() - started);
  // The drain removes the lock BEFORE it stops the server (`cmd-dev.ts`), so a pid that is gone
  // is a lock already cleared — unless no drain ran, which the clear below finishes.
  while (alive(lock.pid)) {
    if (waited() >= input.timeoutMs) {
      throw new DevStopTimeoutError({ pid: lock.pid, waitedMs: waited() });
    }
    await Bun.sleep(POLL_MS);
  }
  if (await lockNames(input.stateDir, lock.pid)) clearLock(input.stateDir);
  return { stopped: true, pid: lock.pid, port: lock.port, waitedMs: waited(), drained: !windows };
}

/** `--timeout` through `@ultimat3/time`'s grammar, the one a job's `timeout:` is read with. */
function readTimeout(raw: string | undefined): number {
  if (raw === undefined) return defaultStopTimeoutMs();
  let ms = Number.NaN;
  try {
    ms = parseDuration(raw);
  } catch {
    // Refused below with the flag named.
  }
  if (ms > 0) return ms;
  throw new BadFlagError({
    flag: 'timeout',
    command: 'stop',
    reason: 'it is not a positive duration such as 30s, 2m or PT1M',
    fix: 'x stop --timeout 30s --json',
  });
}

export const stopCommand: CliCommand = {
  spec: stopSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('stop', ctx.cwd).dir;
    const timeoutMs = readTimeout(flagString(ctx.args, 'timeout'));
    const { stateDir } = resolveServices(root, ctx.env);
    const result = await stopDev({ stateDir, timeoutMs });
    if (!result.stopped) {
      const stale = result.stale === true;
      return {
        ok: true,
        command: 'stop',
        summary: msg(stale ? 'cli.stop.stale' : 'cli.stop.none'),
        data: { stopped: false, ...(stale ? { stale: true } : {}) },
      };
    }
    const params = { pid: result.pid, port: result.port, ms: result.waitedMs };
    return {
      ok: true,
      command: 'stop',
      summary: msg(result.drained ? 'cli.stop.stopped' : 'cli.stop.terminated', params),
      data: { ...result },
    };
  },
};
