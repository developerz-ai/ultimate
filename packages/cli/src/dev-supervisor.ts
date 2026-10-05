// `x dev` as two processes: this one supervises, a child serves. A save that reaches a module which
// DEFINES a primitive (`app-reload-graph.ts`'s pinned modules — a query over a slice's service, an
// admin page's view under `defineAdmin`) cannot be served by re-importing: the registries and the
// route table hold that module's first instance. The child exits `DEV_RESTART_EXIT_CODE` instead
// of logging "reloaded" over stale code, and this loop boots a fresh one on the same port. Every
// other save stays the in-process reload it was — a restart is paid only where nothing else works.

// why: Bun has no path API; the restart line names files relative to the app root.
import { relative } from 'node:path';
import { drain } from '@ultimat3/core';
import type { StalePin } from './app-reload-graph';
import { devSpec } from './cmd-dev-spec';
import type { DevChildGone } from './dev-child-watch';
import { DEV_SUPERVISOR_PID_ENV, startDevChildWatch, supervisorPid } from './dev-child-watch';
import { devPortFor } from './dev-port';
import { msg } from './messages';
import type { Finding } from './output';
import { parseArgs } from './parse';
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

/** A port nothing holds right now, asked of the OS — what `--port 0` is pinned to. */
export function freeDevPort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port ?? 0;
  probe.stop(true);
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
  Bun.spawn([...command], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env });

/**
 * Runs children until one exits with anything but `DEV_RESTART_EXIT_CODE`, and answers that code.
 * SIGINT and SIGTERM are forwarded — a terminal's Ctrl-C reaches the child on its own too, and its
 * drain is idempotent — and once one arrived no child is started again: a Ctrl-C during a restart
 * is a stop, never a respawn.
 *
 * Every other way out stops the child too: an uncaught error or a `process.exit` here reaches the
 * `exit` listener, which SIGTERMs a child still running. The one way no listener sees is a SIGKILL
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
    child?.kill(signal);
  };
  const onInt = forward('SIGINT');
  const onTerm = forward('SIGTERM');
  const onExit = (): void => {
    if (running) child?.kill('SIGTERM');
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
        ? relative(root, pinned)
        : `${relative(root, changed)} under ${relative(root, pinned)}`,
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
    at: first === undefined ? '' : relative(root, first.pinned),
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
