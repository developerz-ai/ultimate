// One responsibility: ONE start of a Chrome process — spawn it on a throwaway profile, wait for its
// first DevTools answer, and on no answer reap it (killed, awaited, profile removed) and say why.
// Which binary, which flags and how many starts is `cdp-launch.ts`.

import { renderThrowable } from '@ultimat3/core';
import type { CdpConnection } from './cdp-connection';
import type { CdpLaunchAttempt } from './cdp-errors';
import { CdpTimeoutError } from './cdp-errors';
import { throwawayProfile } from './cdp-launch-profile';
import { CLOSE_GRACE_MS, killTree } from './cdp-launch-reap';
import type { CdpWire } from './cdp-launch-wire';
import { pipeConnection, portConnection, wireStdio } from './cdp-launch-wire';

export { CLOSE_GRACE_MS } from './cdp-launch-reap';

/**
 * The longest `LaunchedBrowser.close()` is DESIGNED to take: SIGTERM's grace, SIGKILL's, the group
 * reap, then the profile's removal — four `CLOSE_GRACE_MS`, each step bounded by its own. A hook
 * that closes a browser and gives it less is killed by Bun mid-close, and when that hook is the
 * run's last the process exits with the profile half-removed: the `Default/Cache` tree the leaked
 * `x-e2e-chrome-*` directories held.
 */
export const LAUNCHED_CLOSE_MS = 4 * CLOSE_GRACE_MS;

export interface LaunchedBrowser {
  /** The browser's own CDP connection, over its debugging pipe or port. Already answering. */
  readonly connection: CdpConnection;
  /**
   * THE close, idempotent, and awaited by every caller: the connection closed, SIGTERM, SIGKILL
   * after `CLOSE_GRACE_MS`, then the browser's whole process group killed and, only then, the
   * profile removed — bounded at `LAUNCHED_CLOSE_MS`. On Windows, which has no SIGTERM to grant grace to, the process TREE
   * is killed outright (`killTree`) and awaited. A promise because a Chrome still shutting down competes with the next
   * launch on a 4-CPU runner, and its children re-create a profile removed before they are gone.
   */
  close(): Promise<void>;
}

export interface LaunchAttemptOptions {
  readonly executable: string;
  /** What the process is started with, given the profile directory this attempt made for it. */
  readonly flags: (profileDir: string) => readonly string[];
  /** Which wire the flags opened — `cdp-launch-wire.ts`. */
  readonly wire: CdpWire;
  /** Whose process rules the reap follows. Defaults to this process's platform. */
  readonly platform?: string | undefined;
  /** Every call's deadline AFTER the first. */
  readonly timeoutMs: number;
  /** The first call's deadline: how long a cold start may take. */
  readonly launchTimeoutMs: number;
}

export type LaunchAttemptResult =
  | { readonly ok: true; readonly browser: LaunchedBrowser }
  /** `reaped: false` is a process that outlived SIGKILL's grace — never start another beside it. */
  | { readonly ok: false; readonly failure: CdpLaunchAttempt; readonly reaped: boolean };

const STDERR_TAIL_CHARS = 4_000;
/** How much of the tail one attempt hands a cause: the last lines, each cut to a readable width. */
const TAIL_LINES = 3;
const TAIL_LINE_CHARS = 160;

/**
 * Read stderr to its end for the life of the process, keeping only a bounded tail. A pipe nobody
 * reads fills, and Chrome's next stderr write then blocks the thread making it — a browser that
 * stops answering mid-run for a reason no log shows. The tail is the launch-failure diagnostics:
 * a missing library, a sandbox refusal and a bad flag are all named there and nowhere else.
 */
function stderrTail(stream: ReadableStream<Uint8Array>): {
  readonly lastLines: () => string;
  /** Settles once the stream has ended — every byte the process wrote has been read. */
  readonly drained: Promise<void>;
} {
  let text = '';
  const drained = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      text = (text + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_CHARS);
    }
  })().catch(() => undefined);
  const lastLines = (): string =>
    text
      .trim()
      .split('\n')
      .slice(-TAIL_LINES)
      .map((line) => line.slice(0, TAIL_LINE_CHARS))
      .join(' | ');
  return { lastLines, drained };
}

/**
 * How long a browser that CLOSED ITS PIPE gets to finish dying, and any browser's stderr to finish
 * draining, before the tail is read. The pipe ending and the stderr reader reaching the last line
 * are two unordered events; read at the first, the reason a browser died was reported as "printed
 * nothing". Bounded, because a WEDGED browser neither exits nor closes stderr.
 */
const FAILURE_DRAIN_MS = 1_000;

/**
 * The longest a FAILED attempt spends after its deadline before the next can start: the drain a
 * browser that hung up gets, the bounded close (`LAUNCHED_CLOSE_MS`), then the stderr drain. A
 * caller's hook deadline adds this per attempt.
 */
export const LAUNCH_REAP_MS = FAILURE_DRAIN_MS + LAUNCHED_CLOSE_MS + FAILURE_DRAIN_MS;

const within = (ms: number, work: Promise<unknown>): Promise<unknown> =>
  Promise.race([work, Bun.sleep(ms)]);

/**
 * Start the browser once and answer when it has answered one CDP call. With a pipe there is no
 * "DevTools listening" line to wait for — the first reply IS the readiness signal.
 */
export async function launchAttempt(options: LaunchAttemptOptions): Promise<LaunchAttemptResult> {
  const platform = options.platform ?? process.platform;
  const profile = throwawayProfile();
  const profileDir = profile.path;
  const began = performance.now();
  let child: ReturnType<typeof spawnBrowser>;
  try {
    child = spawnBrowser(options, profileDir, platform);
  } catch (error) {
    // A binary that cannot be started at all — not there, not executable, not an executable FORMAT
    // this OS runs (a `#!` script on Windows). Bun throws from `spawn`, synchronously, and that
    // throw escaped as a bare ENOENT where every other way a launch fails is X_CDP_LAUNCH_FAILED.
    await profile.remove(undefined, CLOSE_GRACE_MS);
    return {
      ok: false,
      failure: {
        why: 'spawn',
        waitedMs: 0,
        exitCode: null,
        stderr: '',
        detail: renderThrowable(error),
      },
      reaped: true,
    };
  }
  const tail = stderrTail(child.stderr as ReadableStream<Uint8Array>);
  let connection: CdpConnection | undefined =
    options.wire === 'pipe' ? pipeConnection(child.stdio, options.timeoutMs) : undefined;
  let exiting: Promise<void> | undefined;
  const close = (): Promise<void> => {
    exiting ??= (async () => {
      // Read while the browser still runs: a clean exit unlinks it, a killed one never does.
      const singleton = profile.singletonDir();
      connection?.close();
      if (platform === 'win32') {
        // No SIGTERM to grant grace to: a kill on Windows is TerminateProcess, and taking the
        // browser alone would orphan the children that hold the profile's files open.
        await killTree(child.pid, platform);
        await within(CLOSE_GRACE_MS, child.exited);
      } else {
        child.kill();
        const exited =
          (await within(
            CLOSE_GRACE_MS,
            child.exited.then(() => true),
          )) === true;
        if (!exited) {
          child.kill('SIGKILL');
          await within(CLOSE_GRACE_MS, child.exited);
        }
        await killTree(child.pid, platform);
      }
      // Only now, with the tree gone: removed under a live browser, the profile is re-created by
      // its shutdown — the network process flushes its cache, the browser writes its prefs — and
      // a close cut short there leaves exactly that tree. Measured on Chrome 150, 30 launches
      // each: left behind 6 and 12 times without the group reap, 0 with.
      await profile.remove(singleton, CLOSE_GRACE_MS);
    })();
    return exiting;
  };
  try {
    // The pipe needs no wait to exist; the port is not known until the browser writes it down, and
    // finding it spends the same launch deadline the first answer does.
    connection ??= await portConnection({
      profileDir,
      exited: () => child.exitCode !== null || child.signalCode !== null,
      deadlineMs: options.launchTimeoutMs,
      timeoutMs: options.timeoutMs,
    });
    const left = Math.max(1, options.launchTimeoutMs - (performance.now() - began));
    await connection.send('Browser.getVersion', {}, undefined, left);
    return { ok: true, browser: { connection, close } };
  } catch (error) {
    const why = error instanceof CdpTimeoutError ? 'deadline' : 'closed';
    // The deadline itself when that is what ended it: the number the reader can raise.
    const waitedMs =
      why === 'deadline' ? options.launchTimeoutMs : Math.round(performance.now() - began);
    // Only a browser that hung up may be on its way out with the reason still unwritten. One that
    // was silent for the whole deadline has had its time.
    if (why === 'closed') await within(FAILURE_DRAIN_MS, child.exited);
    // Read BEFORE the kill: after it, an exit code is ours and says nothing about the browser.
    const exitCode = child.exitCode;
    await close();
    await within(FAILURE_DRAIN_MS, tail.drained);
    return {
      ok: false,
      // `detail`: the error itself. Without it a refused dial after "DevTools listening" read as a
      // browser that hung up (seen on windows), and nothing said which step had failed.
      failure: {
        why,
        waitedMs,
        exitCode,
        stderr: tail.lastLines(),
        detail: renderThrowable(error),
      },
      reaped: child.exitCode !== null || child.signalCode !== null,
    };
  }
}

/**
 * The process, on its own process GROUP on POSIX so the zygote, GPU and network processes are
 * reaped with it (`killTree`). It still ends with this process on the pipe wire: Chrome exits when
 * its fd 3 closes. Windows has no group to make — `detached` there is a console flag — so not.
 */
function spawnBrowser(options: LaunchAttemptOptions, profileDir: string, platform: string) {
  // Spread into a fresh tuple: Bun's `stdio` type takes a mutable tuple, never a readonly one.
  const [stdin, stdout, stderr, ...extra] = wireStdio(options.wire);
  return Bun.spawn([options.executable, ...options.flags(profileDir)], {
    stdio: [stdin, stdout, stderr, ...extra],
    detached: platform !== 'win32',
  });
}
