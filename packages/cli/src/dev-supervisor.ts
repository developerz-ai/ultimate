// `x dev` as two processes: this one supervises, a child serves. A save that reaches a module which
// DEFINES a primitive (`app-reload-graph.ts`'s pinned modules — a query over a slice's service, an
// admin page's view under `defineAdmin`) cannot be served by re-importing: the registries and the
// route table hold that module's first instance. The child exits `DEV_RESTART_EXIT_CODE` instead
// of logging "reloaded" over stale code, and this loop boots a fresh one on the same port. Every
// other save stays the in-process reload it was — a restart is paid only where nothing else works.

import { drain } from '@ultimat3/core';
import type { StalePin } from './app-reload-graph';
import { devSpec } from './cmd-dev-spec';
import type { DevChildGone, DevDrainMessage } from './dev-child-watch';
import {
  DEV_SUPERVISOR_PID_ENV,
  devHardExitMs,
  startDevChildWatch,
  supervisorPid,
} from './dev-child-watch';
import { devPortFor } from './dev-port';
import { PORT_RANGE } from './flag-number';
import { msg } from './messages';
import type { Finding } from './output';
import { parseArgs } from './parse';
import { posixRelative } from './posix-path';
import { writeErrorLine } from './write-line';

/** Set on the child: it serves, and a pinned save makes it exit for a restart. */
export const DEV_CHILD_ENV = 'ULTIMATE_DEV_CHILD';
/** `EX_TEMPFAIL`: "try again" — the one exit code the supervisor answers with a new child. */
export const DEV_RESTART_EXIT_CODE = 75;

/** What the supervisor runs the child with: the argv, its port pinned. */
export interface DevSupervision {
  readonly argv: readonly string[];
}

/**
 * Whether this `x …` invocation is a supervised `x dev`, and with what child argv. Not for the
 * child itself, `--once` (it boots, reports and exits — nothing to restart), `--help`, or an argv
 * the parse refuses (`dispatch` reports that, in the child's place). `--port 0` is pinned to one
 * free port here, so a restarted child binds the address the first one printed.
 */
export function devSupervision(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  pickPort: () => number,
): DevSupervision | undefined {
  if (argv[0] !== 'dev' || env[DEV_CHILD_ENV] === '1') return undefined;
  try {
    const args = parseArgs(argv, [devSpec]);
    if (args.help || args.flags.get('once') === true) return undefined;
    return { argv: devPortFor(args, env) === 0 ? withPort(argv, pickPort()) : argv };
  } catch {
    return undefined;
  }
}

/** A port the OS hands out for `0`, released at once — the candidate `freeDevPort` checks. */
const kernelPort = (): number => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port ?? 0;
  probe.stop(true);
  return port;
};

/** Whether `port` can be bound right now: `Bun.serve` refusing it is the answer, not an error. */
const portBindable = (port: number): boolean => {
  try {
    Bun.serve({ port, fetch: () => new Response() }).stop(true);
    return true;
  } catch {
    return false;
  }
};

/** Kernel candidates tried for a free PAIR before the last one is handed back unchecked. */
const PAIR_ATTEMPTS = 16;

/**
 * A port whose PAIR nothing holds right now — what `--port 0` is pinned to. `x dev` binds the web
 * role on `port` and the sync role on `port + 1` (`syncPortFor`), so a port the kernel says is
 * free proves nothing about its neighbour: asking for one alone failed the boot `X_PORT_IN_USE`
 * on a busy box whenever the neighbour was taken (`cmd-dev-orphan.live.test.ts`, 2026-10-07).
 */
export function freeDevPort(
  pick: () => number = kernelPort,
  bindable: (port: number) => boolean = portBindable,
): number {
  let port = 0;
  for (let attempt = 0; attempt < PAIR_ATTEMPTS; attempt += 1) {
    port = pick();
    if (port > 0 && port < PORT_RANGE.max && bindable(port + 1)) return port;
  }
  return port;
}

/** `argv` with every `--port` removed and `--port <port>` appended. */
function withPort(argv: readonly string[], port: number): readonly string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--port') {
      index += 1;
      continue;
    }
    if (token.startsWith('--port=')) continue;
    out.push(token);
  }
  return [...out, '--port', String(port)];
}

/** The child as the loop sees it — `Bun.spawn`'s answer, narrowed so a test can hand one in. */
export interface DevChild {
  readonly exited: Promise<number>;
  kill(signal: 'SIGINT' | 'SIGTERM'): void;
  /** The IPC channel; absent or closed, `stopChild` falls back to the signal. */
  send?(message: DevDrainMessage): void;
}

/**
 * Asks the child to drain: a `drain` message over IPC, on every platform — on Windows
 * `kill('SIGTERM')` is TerminateProcess, which skips the drain and leaves the embedded database
 * unclean. The signal only when there is no channel to ask over (it closed, or a test's child) —
 * or once `afterMs` has passed with the child still running: one still booting has no listener
 * yet and drops the message, and a stop that never lands is a supervisor waiting forever.
 */
export function stopChild(
  child: DevChild,
  signal: 'SIGINT' | 'SIGTERM',
  afterMs: number = devHardExitMs(),
): void {
  if (child.send !== undefined) {
    try {
      child.send({ type: 'x-dev-drain', signal });
      const fallback = setTimeout(() => child.kill(signal), afterMs);
      // Never what keeps this process alive: awaiting the child's exit is.
      fallback.unref();
      void child.exited.then(() => clearTimeout(fallback));
      return;
    } catch {
      // The channel closed under us: the child is exiting or gone, and the signal is all that's left.
    }
  }
  child.kill(signal);
}

export interface SuperviseDevInput {
  readonly bin: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly spawn?: (
    command: readonly string[],
    env: Record<string, string | undefined>,
  ) => DevChild;
}

const spawnInherited = (
  command: readonly string[],
  env: Record<string, string | undefined>,
): DevChild =>
  Bun.spawn([...command], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env,
    // The channel `stopChild` drains over; the child sends nothing back.
    ipc: () => undefined,
  });

/**
 * Runs children until one exits with anything but `DEV_RESTART_EXIT_CODE`, and answers that code.
 * SIGINT and SIGTERM are forwarded as a `drain` message (`stopChild`) — a terminal's Ctrl-C reaches
 * the child on its own too, and its drain is idempotent — and once one arrived no child is started
 * again: a Ctrl-C during a restart is a stop, never a respawn.
 *
 * Every other way out stops the child too: an uncaught error or a `process.exit` here reaches the
 * `exit` listener, which asks a child still running to drain. The one way no listener sees is a SIGKILL
 * of this process — the child's own watch (`dev-child-watch.ts`) answers that, from its side, off
 * the pid this loop hands it.
 */
export async function superviseDev(input: SuperviseDevInput): Promise<number> {
  const spawn = input.spawn ?? spawnInherited;
  let child: DevChild | undefined;
  let running = false;
  let stopping = false;
  const forward = (signal: 'SIGINT' | 'SIGTERM') => (): void => {
    stopping = true;
    if (child !== undefined) stopChild(child, signal);
  };
  const onInt = forward('SIGINT');
  const onTerm = forward('SIGTERM');
  const onExit = (): void => {
    if (running && child !== undefined) stopChild(child, 'SIGTERM');
  };
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  process.on('exit', onExit);
  try {
    for (;;) {
      child = spawn([process.execPath, input.bin, ...input.argv], {
        ...input.env,
        [DEV_CHILD_ENV]: '1',
        [DEV_SUPERVISOR_PID_ENV]: String(process.pid),
      });
      running = true;
      const code = await child.exited;
      running = false;
      if (code !== DEV_RESTART_EXIT_CODE || stopping) return code;
    }
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    process.off('exit', onExit);
  }
}

/** `apps/web/app/greet/service.ts under apps/web/app/greet/queries.ts`, one per pinned module. */
export function restartReason(root: string, pins: readonly StalePin[]): string {
  return pins
    .map(({ changed, pinned }) =>
      changed === pinned
        ? posixRelative(root, pinned)
        : `${posixRelative(root, changed)} under ${posixRelative(root, pinned)}`,
    )
    .join(', ');
}

/** `/_x`'s finding for a process nothing supervises (an embedded `startDev()` with no `onRestart`). */
export function restartFinding(root: string, pins: readonly StalePin[]): Finding {
  const first = pins[0];
  return {
    code: 'X_DEV_RESTART_REQUIRED',
    cause: `${restartReason(root, pins)} — a module that defines a primitive still holds the code before the save, and re-importing it would register a second definition`,
    fix: 'restart x dev (a supervised `x dev` restarts itself; an embedded startDev() passes onRestart)',
    at: first === undefined ? '' : posixRelative(root, first.pinned),
  };
}

/** The child's half: what `startDev` is handed, and what the hold calls once released. */
export interface ChildRestart {
  readonly options: { readonly onRestart?: (pins: readonly StalePin[]) => void };
  readonly exit: (code: number) => void;
}

/**
 * Only a supervised child restarts: it says why on stderr (fd 1 may be `--json`'s one document),
 * starts core's drain — the hold then releases the lock, the port and the embedded database — and
 * exits `DEV_RESTART_EXIT_CODE` once released. Anything else keeps the finding on `/_x`.
 *
 * A child its supervisor named (`DEV_SUPERVISOR_PID_ENV`) also watches for that supervisor's death
 * and its app root's, and stops on either — exit 1 for a root that is gone, which the supervisor,
 * if it is still there, answers by stopping rather than respawning into nothing.
 */
export function childRestart(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  watch: typeof startDevChildWatch = startDevChildWatch,
): ChildRestart {
  if (env[DEV_CHILD_ENV] !== '1') return { options: {}, exit: () => undefined };
  let leaving: 'restart' | DevChildGone | undefined;
  const watched =
    supervisorPid(env) === undefined
      ? undefined
      : watch(root, env, (why) => {
          leaving ??= why;
        });
  return {
    options: {
      onRestart: (pins) => {
        writeErrorLine(msg('cli.dev.restart', { reason: restartReason(root, pins) }));
        leaving ??= 'restart';
        watched?.stopping(DEV_RESTART_EXIT_CODE);
        void drain('restart');
      },
    },
    exit: () => {
      if (leaving === 'restart') process.exit(DEV_RESTART_EXIT_CODE);
      if (leaving === 'root') process.exit(1);
    },
  };
}
