// A supervised `x dev` child that outlives what it serves stops itself. Two facts nothing else in
// the child watched: its SUPERVISOR is gone (SIGKILLed, so it forwarded nothing — the child was
// reparented to init and served forever), and its APP ROOT is gone (the jobs worker, the outbox
// relay and the scheduler then poll an embedded database whose directory no longer exists, at
// 100% CPU, measured at ~50 MB/s of heap growth). Found on a laptop, 2026-09-29: two children of
// `cmd-dev-restart.live.test.ts`, six hours old, ppid 1, cwd deleted, one at 7 GB.
//
// Both facts and the stop itself hold on Windows: the supervisor is asked for by pid
// (`process.kill(pid, 0)`), since a Windows child's ppid never changes, and a stop arrives as a
// `drain` message over IPC — `kill('SIGTERM')` there is TerminateProcess, with no drain at all.
//
// And a stop that does not finish is finished for it. A drain is bounded by core's deadline, but a
// loop starved by a spin like the one above reaches its timers late or never, so every stop this
// child begins — a signal, the watch below, a restart — carries a hard exit past that bound.

import { existsSync } from 'node:fs'; // why: one synchronous stat per tick; Bun has no sync exists.
import { drain, drainDeadlineMs, ERROR_DOCS_URL, finiteCount, logger } from '@ultimat3/core';
import { MIN_RELEASE_MS } from './hold';

/** Set on the child by the supervisor: its own pid, so a child started after it died still knows. */
export const DEV_SUPERVISOR_PID_ENV = 'ULTIMATE_DEV_SUPERVISOR_PID';

/** How often the child asks. A second: a dead supervisor's child is gone about a second later. */
export const DEV_CHILD_WATCH_MS = 1_000;

/** Past the drain's own deadline and `hold.ts`'s release floor, a stop is not going to finish. */
export const devHardExitMs = (): number => drainDeadlineMs() + MIN_RELEASE_MS + 5_000;

export type DevChildGone = 'supervisor' | 'root';

export interface DevChildWatchInput {
  readonly root: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Called once, when the child decides to leave. */
  readonly leave: (why: DevChildGone) => void;
  /** Test seams: the defaults read the process table and the disk. */
  readonly supervisorAlive?: (pid: number) => boolean;
  readonly rootExists?: (root: string) => boolean;
  readonly intervalMs?: number;
}

/** The supervisor's pid, or `undefined` when this process was not started by one. */
export function supervisorPid(
  env: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const said = Number(env[DEV_SUPERVISOR_PID_ENV]);
  return Number.isInteger(said) && said > 0 ? said : undefined;
}

/** `process.kill(pid, 0)`'s answer: delivered, or refused for permission — both mean it exists. */
export function pidAlive(
  pid: number,
  kill: (pid: number, signal: 0) => void = process.kill,
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { readonly code?: unknown } | null)?.code === 'EPERM';
  }
}

/**
 * Whether the supervisor at `pid` still runs this child. POSIX asks the ppid — immune to a reused
 * pid, and a supervisor that died before the first tick is still caught, since the child is
 * reparented. Windows never reparents (the ppid stays the dead supervisor's forever), so there the
 * process table is asked directly.
 */
export function defaultSupervisorAlive(
  platform: string = process.platform,
): (pid: number) => boolean {
  return platform === 'win32' ? (pid) => pidAlive(pid) : (pid) => process.ppid === pid;
}

/**
 * Polls both facts until one fails, then calls `leave` once and stops. Answers the stop. Polled
 * rather than a pipe from the supervisor: stdin is the terminal's (`inherit`), and IPC closing is
 * not a fact Bun reports to the child.
 */
export function watchDevChild(input: DevChildWatchInput): () => void {
  const expected = supervisorPid(input.env);
  const alive = input.supervisorAlive ?? defaultSupervisorAlive();
  const exists = input.rootExists ?? existsSync;
  let left = false;
  const timer = setInterval(
    () => {
      if (left) return;
      const why: DevChildGone | undefined =
        expected !== undefined && !alive(expected)
          ? 'supervisor'
          : exists(input.root)
            ? undefined
            : 'root';
      if (why === undefined) return;
      left = true;
      clearInterval(timer);
      input.leave(why);
    },
    finiteCount('watchDevChild', 'intervalMs', input.intervalMs ?? DEV_CHILD_WATCH_MS, 1),
  );
  // Never the reason the process is alive — the hold is, and a watch outliving it would be a leak.
  timer.unref();
  return () => {
    left = true;
    clearInterval(timer);
  };
}

/** The line the child leaves on stderr (fd 1 may be `--json`'s one document). */
export function reportGone(root: string, why: DevChildGone): void {
  if (why === 'root') {
    logger.error('X_DEV_ROOT_GONE', {
      code: 'X_DEV_ROOT_GONE',
      cause: `${root}, the app root this x dev serves, no longer exists — nothing is left to serve, so it stops instead of polling a database whose directory is gone`,
      fix: 'x dev   # from the app root, once it exists again (restored, re-cloned or moved back)',
      docs: ERROR_DOCS_URL,
    });
    return;
  }
  logger.warn('dev.supervisor.gone', {
    cause:
      'the x dev supervisor that started this child exited without stopping it (a SIGKILL cannot be forwarded), so the child stops itself',
  });
}

/**
 * One hard exit, armed by the first stop and never disarmed: it is NOT unref'd, because it is the
 * one timer that must still fire once everything else is done or stuck. `exit` is the test seam.
 */
export function hardExit(
  exit: (code: number) => void,
  afterMs: () => number = devHardExitMs,
): (code: number) => void {
  let armed = false;
  return (code: number): void => {
    if (armed) return;
    armed = true;
    const ms = afterMs();
    setTimeout(() => {
      logger.warn('dev.stop.forced', {
        cause: `x dev was still stopping ${String(ms)}ms after it began, so it exits without finishing`,
      });
      exit(code);
    }, ms);
  };
}

/** What the supervisor sends for a stop: the signal it would have forwarded on POSIX. */
export interface DevDrainMessage {
  readonly type: 'x-dev-drain';
  readonly signal: 'SIGINT' | 'SIGTERM';
}

export function isDevDrainMessage(message: unknown): message is DevDrainMessage {
  if (typeof message !== 'object' || message === null) return false;
  const { type, signal } = message as Record<string, unknown>;
  return type === 'x-dev-drain' && (signal === 'SIGINT' || signal === 'SIGTERM');
}

/** The exit code a stop for `signal` answers: 128 + its number, as a shell reports it. */
export const signalExitCode = (signal: 'SIGINT' | 'SIGTERM'): number =>
  signal === 'SIGINT' ? 130 : 143;

/**
 * The child's watch, wired to core's drain: the supervisor's death or the root's, SIGINT or
 * SIGTERM, and the supervisor's `drain` message each begin a stop that ends within
 * `devHardExitMs` however the drain fares. `onGone` marks why, so the hold's exit can answer a code.
 */
export function startDevChildWatch(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  onGone: (why: DevChildGone) => void,
): { readonly stopping: (code: number) => void } {
  const stopping = hardExit((code) => process.exit(code));
  // Beside core's own handlers, never instead of them: the drain is theirs, the deadline is this.
  process.on('SIGINT', () => stopping(signalExitCode('SIGINT')));
  process.on('SIGTERM', () => stopping(signalExitCode('SIGTERM')));
  // The supervisor's stop, on every platform: the same drain a signal begins, by message.
  process.on('message', (message: unknown) => {
    if (!isDevDrainMessage(message)) return;
    stopping(signalExitCode(message.signal));
    void drain(message.signal);
  });
  watchDevChild({
    root,
    env,
    leave: (why) => {
      reportGone(root, why);
      onGone(why);
      stopping(why === 'root' ? 1 : 0);
      void drain(why === 'root' ? 'dev-root-gone' : 'dev-supervisor-gone');
    },
  });
  return { stopping };
}
