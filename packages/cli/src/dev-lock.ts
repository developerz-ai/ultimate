// `x dev`'s preflight: the two ways a second one fails, refused before anything boots.
//
// Both were reachable in 5.0.1 and both reported the wrong thing.
//
// A PORT already bound surfaced as `X_CLI_UNEXPECTED` wrapping Bun's own text — "Failed to start
// server. Is port 3000 in use?", a guess phrased as a question — with `fix: x doctor --json`, a
// command whose output does not mention the port. Port 3000 being taken by another project is the
// normal case on a developer machine, and `--port` was never named.
//
// A second `x dev` on ONE checkout failed later and worse. Embedded PGlite is a single-writer data
// directory, so the second boot died on `X_DB_UNAVAILABLE` while creating the jobs table, whose
// `fix:` reads "run `x dev` to use the embedded PGlite" — naming the command that had just failed.
//
// The lock file is what makes the second one nameable at all: nothing else in the process can tell
// "another dev server owns this directory" from "the database is broken".

import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { docsFor } from './error-codes';

/** Where the running dev server records itself, inside the state directory it already owns. */
export const DEV_LOCK_FILE = 'dev.lock';

export interface DevLock {
  readonly pid: number;
  readonly port: number;
  readonly url: string;
  /** ISO 8601. Only ever printed — a stale lock is decided by the pid, never by the clock. */
  readonly startedAt: string;
}

export const lockPath = (stateDir: string): string => join(stateDir, DEV_LOCK_FILE);

/**
 * Parse a lock file's contents. Total: a truncated or hand-edited file is a stale lock, not a
 * crash — this runs on the path whose entire job is to make a confusing failure clear.
 */
export const parseLock = (raw: string): DevLock | null => {
  try {
    const value = JSON.parse(raw) as Partial<DevLock>;
    if (typeof value.pid !== 'number' || typeof value.port !== 'number') return null;
    return {
      pid: value.pid,
      port: value.port,
      url: typeof value.url === 'string' ? value.url : `http://localhost:${value.port}`,
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : '',
    };
  } catch {
    return null;
  }
};

/**
 * Is the pid in the lock still running? Signal 0 checks for existence without delivering anything.
 *
 * A hard kill leaves the lock behind, which is the common case and must NOT block the next boot —
 * so a dead pid means the lock is stale and gets cleared. The rare wrong answer is a recycled pid
 * belonging to something else; the cost of that is one unnecessary refusal that `--port` resolves,
 * against the cost of the alternative, which is a silent second writer on a single-writer database.
 */
export const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to another user. Alive, and not ours to signal.
    return (error as { code?: string }).code === 'EPERM';
  }
};

/** Refused before boot, so the failure names the process holding the directory. */
export class DevAlreadyRunningError extends UltimateError {
  constructor(input: { readonly lock: DevLock; readonly stateDir: string }) {
    super({
      code: 'X_DEV_ALREADY_RUNNING',
      cause: `pid ${input.lock.pid} is already running x dev on ${input.lock.url} and holds ${input.stateDir} — embedded Postgres is a single-writer data directory, so a second one cannot open it`,
      fix: `use the one already running at ${input.lock.url}, or stop it: kill ${input.lock.pid}`,
      docs: docsFor('X_DEV_ALREADY_RUNNING'),
      meta: { pid: input.lock.pid, port: input.lock.port, stateDir: input.stateDir },
    });
  }
}

/** Whatever is listening, as far as the OS will say. Both fields absent when it will not say. */
export interface PortHolder {
  readonly pid?: number;
  /** The process name, e.g. `bun`. Enough to recognise "that is my other project". */
  readonly command?: string;
}

/**
 * Who holds the port. `ss` first because it is present on every Linux box the framework targets and
 * needs no elevation for your own processes; `lsof` is the macOS answer.
 *
 * Best-effort by construction: neither tool is a dependency, and a machine with neither still gets
 * the refusal, just without a pid in it. Nothing here shells out with user input — the port is an
 * integer this process validated.
 */
export const portHolder = (port: number): PortHolder => {
  const ss = Bun.spawnSync(['ss', '-lptnH', `sport = :${port}`], { stderr: 'ignore' });
  const parsed = /users:\(\("([^"]+)",pid=(\d+)/.exec(ss.stdout?.toString() ?? '');
  const name = parsed?.[1];
  if (parsed !== null && name !== undefined) return { command: name, pid: Number(parsed[2]) };

  const lsof = Bun.spawnSync(['lsof', '-nP', '-iTCP:' + String(port), '-sTCP:LISTEN', '-Fpc'], {
    stderr: 'ignore',
  });
  const lines = (lsof.stdout?.toString() ?? '').split('\n');
  const pid = lines.find((line) => line.startsWith('p'))?.slice(1);
  const command = lines.find((line) => line.startsWith('c'))?.slice(1);
  if (pid !== undefined && /^\d+$/.test(pid)) {
    return command === undefined ? { pid: Number(pid) } : { command, pid: Number(pid) };
  }
  return {};
};

/**
 * The port is bound by something that is not us. Named separately from the lock case because the
 * remedy is different: a stranger's port is worked around with `--port`, while a second `x dev` on
 * this checkout is not a port problem at all and moving it would still fail on the database.
 *
 * The holder is NAMED when the OS will say. On a developer machine :3000 is usually another
 * project's dev server, and "pid 41234, bun" is the difference between knowing that and guessing —
 * which decides whether the right move is `--port` or stopping the other thing. Both are offered,
 * `--port` first: moving your own server is always safe, and killing someone else's is not.
 */
export class DevPortInUseError extends UltimateError {
  constructor(input: {
    readonly port: number;
    readonly suggestion: number;
    readonly holder?: PortHolder;
  }) {
    const holder = input.holder ?? {};
    const named =
      holder.pid === undefined
        ? 'another process'
        : `pid ${holder.pid}${holder.command === undefined ? '' : ` (${holder.command})`}`;
    super({
      code: 'X_PORT_IN_USE',
      cause: `:${input.port} is already bound by ${named}, so the web role cannot listen — on a machine running several projects this is usually another one's dev server, not a stale copy of this one`,
      fix:
        holder.pid === undefined
          ? `x dev --port ${input.suggestion}`
          : `x dev --port ${input.suggestion}   # or free it, if that pid is yours: kill ${holder.pid}`,
      docs: docsFor('X_PORT_IN_USE'),
      meta: { port: input.port, ...holder },
    });
  }
}

/**
 * The next port to suggest. Never `port + 1` at the top of the range — 65536 is not a port, and a
 * `fix:` that cannot run is the failure this whole module exists to end.
 */
export const suggestPort = (port: number): number => (port >= 65535 ? port - 1 : port + 1);

/** Is anything listening? A successful bind-then-close is the only answer that does not lie. */
export const isPortBound = (port: number, hostname = '127.0.0.1'): boolean => {
  try {
    const probe = Bun.listen({ hostname, port, socket: { data() {} } });
    probe.stop(true);
    return false;
  } catch {
    return true;
  }
};

export interface PreflightInput {
  readonly stateDir: string;
  readonly port: number;
  /** Injected by the test; `isPortBound` in production. */
  readonly portBound?: (port: number) => boolean;
  readonly alive?: (pid: number) => boolean;
  readonly holder?: (port: number) => PortHolder;
}

/**
 * Run before anything boots. Throws the coded refusal, or returns the stale lock it cleared so the
 * caller can say so — a lock left by a hard kill is normal and worth one line, not a failure.
 */
export const preflight = async (input: PreflightInput): Promise<{ clearedStale: boolean }> => {
  const alive = input.alive ?? isProcessAlive;
  const bound = input.portBound ?? isPortBound;
  const path = lockPath(input.stateDir);
  const file = Bun.file(path);
  let clearedStale = false;

  if (await file.exists()) {
    const lock = parseLock(await file.text());
    if (lock !== null && alive(lock.pid)) {
      throw new DevAlreadyRunningError({ lock, stateDir: input.stateDir });
    }
    // Stale: a hard kill, or a file nothing here wrote. Removing it is what makes the next boot
    // work, and `unlinkSync` because a lock that outlives its own cleanup is the bug being fixed.
    try {
      unlinkSync(path);
    } catch {
      // Already gone, or not ours to remove. Either way the boot below is what decides.
    }
    clearedStale = true;
  }

  if (bound(input.port)) {
    throw new DevPortInUseError({
      port: input.port,
      suggestion: suggestPort(input.port),
      holder: (input.holder ?? portHolder)(input.port),
    });
  }
  return { clearedStale };
};

/** Record this process. Written after the preflight passes and before the roles start. */
export const writeLock = async (stateDir: string, lock: DevLock): Promise<void> => {
  await Bun.write(lockPath(stateDir), `${JSON.stringify(lock, null, 2)}\n`);
};

/** Remove it. Safe to call twice — shutdown paths overlap, and a throw here would mask the real one. */
export const clearLock = (stateDir: string): void => {
  try {
    unlinkSync(lockPath(stateDir));
  } catch {
    // Never written, already removed, or removed by a concurrent shutdown. Nothing to report.
  }
};
