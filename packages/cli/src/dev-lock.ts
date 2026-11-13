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

import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringField, UltimateError } from '@ultimat3/core';
import { reusedPid, startedOf } from './dev-lock-identity';
import { type PortHolder, portHolder } from './dev-lock-port-holder';
import { stealStale } from './dev-lock-steal';
import { portPairAfter } from './flag-number';
import { quoteArg } from './shell-quote';

/** Where the running dev server records itself, inside the state directory it already owns. */
export const DEV_LOCK_FILE = 'dev.lock';

export interface DevLock {
  readonly pid: number;
  readonly port: number;
  readonly url: string;
  /** ISO 8601. Only ever printed — a stale lock is decided by the pid, never by the clock. */
  readonly startedAt: string;
  /** The holder's OS start time (`dev-lock-identity.ts`): a reused pid does not match it. */
  readonly started?: string;
}

export { netstatListener, portHolder, tasklistImage } from './dev-lock-port-holder';
// Re-exported: the port refusal's holder, split out at the file ceiling.
export type { PortHolder };
// Re-exported: `cmd-stop.ts` asks the same question before it signals.
export { reusedPid };

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
      ...(typeof value.started === 'string' ? { started: value.started } : {}),
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
    // `stringField`, never a cast plus a property read: the rule `metrics-endpoint.ts` states and
    // `caught-value-reads.test.ts` enforces — a getter that throws would take this path down one
    // line before the guard meant to make it safe, and this guard decides whether a second `x dev`
    // is allowed to open a single-writer data directory.
    return stringField(error, 'code') === 'EPERM';
  }
};

/**
 * The lock a LIVE `x dev` holds on this state directory, or `undefined` — for a command that must
 * not run beside one (`x db reset` deletes the data directory that process has open). A missing,
 * unreadable or stale lock is no holder: only `preflight` may clear one.
 */
export const liveDevLock = (stateDir: string): DevLock | undefined => {
  let raw: string;
  try {
    raw = readFileSync(lockPath(stateDir), 'utf-8');
  } catch {
    return undefined;
  }
  const lock = parseLock(raw);
  return lock !== null && isProcessAlive(lock.pid) ? lock : undefined;
};

/**
 * Refused before boot, so the failure names the process holding the directory.
 *
 * The lock is on the CHECKOUT, not on the database, and the cause says so. `x dev` is one process
 * running every role (`role-start.ts`), so a second one is unsupported whatever the services are.
 * The embedded-Postgres sentence is appended only when the database actually IS embedded — with an
 * external `DATABASE_URL` it would name a mechanism that is not in play, which is the same defect
 * as the message this whole module replaced.
 */
export class DevAlreadyRunningError extends UltimateError {
  constructor(input: {
    readonly lock: DevLock;
    readonly stateDir: string;
    /** True when this checkout's database is the embedded one. */
    readonly embeddedDb?: boolean;
  }) {
    const single =
      input.embeddedDb === true
        ? ' — embedded Postgres is a single-writer data directory, so a second one cannot open it'
        : ' — x dev runs every role in one process, so a second one on this checkout is unsupported';
    super({
      code: 'X_DEV_ALREADY_RUNNING',
      cause: `pid ${input.lock.pid} is already running x dev on ${input.lock.url} and holds ${input.stateDir}${single}`,
      // `x stop`, not `kill <pid>`: a kill returns before the drain ends and the next boot refuses.
      fix: `use the one already running at ${input.lock.url}, or stop it: x stop --json`,
      meta: { pid: input.lock.pid, port: input.lock.port, stateDir: input.stateDir },
    });
  }
}

/**
 * The lock file exists, this process could not read it and could not remove it — which is not
 * "another x dev is running", and was reported as exactly that.
 *
 * `DevAlreadyRunningError` needs a `DevLock`, and the only one in hand on that path was `mine`:
 * the refusal then read `pid <this process> is already running x dev` with `fix: … kill <this
 * process>`, a remedy that kills the reader and a cause naming the wrong holder. Axiom 4 wants a
 * runnable fix and an honest cause, so the honest answer is its own code — the file is the
 * problem, and removing it is what a reader can actually do.
 */
export class DevLockUnreadableError extends UltimateError {
  constructor(input: { readonly path: string; readonly stateDir: string }) {
    super({
      code: 'X_DEV_LOCK_UNREADABLE',
      cause: `${input.path} could not be parsed as a dev lock and could not be removed, so x dev cannot tell whether another process owns ${input.stateDir}`,
      fix: `rm ${quoteArg(input.path)}   # then re-run x dev`,
      meta: { path: input.path, stateDir: input.stateDir },
    });
  }
}

/**
 * The state directory refused the claim itself: it could not be created, the lock could not be
 * staged in it, or the filesystem would not hard-link the staged file into place. None of that is
 * another `x dev` — only `EEXIST` is — and escaping raw it reached the operator as
 * `X_CLI_UNEXPECTED` with `fix: x doctor --json`, which says nothing about `.x/`.
 */
export class DevStateUnwritableError extends UltimateError {
  constructor(input: { readonly stateDir: string; readonly error: unknown }) {
    // Read the field, never cast and dereference: `unknown` is what a catch hands over.
    const errno = stringField(input.error, 'code') ?? 'an unreported errno';
    super({
      code: 'X_DEV_STATE_UNWRITABLE',
      cause: `${input.stateDir} could not be created, written, or hard-linked into (${errno}), so x dev cannot take its lock — a read-only checkout, a .x/ this user may not write, or a filesystem without hard links`,
      fix: `ls -ld ${quoteArg(input.stateDir)}   # make it writable by this user, on a filesystem that supports hard links, then re-run x dev`,
      meta: { stateDir: input.stateDir, errno },
      sourceError: input.error,
    });
  }
}

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
      meta: { port: input.port, ...holder },
    });
  }
}

/**
 * Is anything listening? A successful bind-then-close is the only answer that does not lie.
 *
 * PROBE THE ADDRESS THE SERVER WILL BIND, which is why the hostname is a parameter and why the
 * caller passes `DEV_BINDING.hostname` rather than accepting a default. Probing a wider address
 * than the server uses is not the safe direction: `0.0.0.0` reports "in use" whenever ANY interface
 * holds the port, so a neighbour bound to one LAN address would refuse a boot that would have
 * succeeded on loopback. Probing a narrower one misses a holder the server would collide with.
 * Matching is the only rule that is right in both directions.
 */
export const isPortBound = (port: number, hostname: string): boolean => {
  try {
    const probe = Bun.listen({ hostname, port, socket: { data() {} } });
    probe.stop(true);
    return false;
  } catch {
    return true;
  }
};

/** A sibling of the lock, unique to this process and call, where its bytes are staged. */
const stagingPath = (path: string): string =>
  `${path}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;

const lockText = (lock: DevLock): string => `${JSON.stringify(lock, null, 2)}\n`;

/**
 * The claim's two filesystem writes. A seam, so a test can see what a rival would read between
 * them without replacing `node:fs` for every module in its process (`mock.module` never undoes).
 */
export interface ClaimFiles {
  readonly write: (path: string, text: string) => void;
  readonly link: (existing: string, path: string) => void;
}

const NODE_CLAIM_FILES: ClaimFiles = {
  write: (path, text) => writeFileSync(path, text),
  link: (existing, path) => linkSync(existing, path),
};

/**
 * Take the lock, or answer `false` because someone else holds it.
 *
 * Written whole to a staging file first, then `linkSync`ed into place: the link is the create AND
 * the exclusivity in ONE syscall (`EEXIST` when the name is taken), so two boots racing this cannot
 * both come back `true` — and the lock path never exists without its contents. It was `openSync(
 * path, 'wx')` and THEN a write; a racing preflight that read the file between the two parsed an
 * empty lock as stale, unlinked the live claim and took the slot itself.
 *
 * Only `EEXIST` is "someone else has it". Any other refusal of the staging write or the link — a
 * `.x/` this user may not write, a filesystem without hard links — is `X_DEV_STATE_UNWRITABLE`
 * naming the directory and the errno, the original kept as its `sourceError`.
 */
function claimExclusive(
  stateDir: string,
  path: string,
  lock: DevLock,
  files: ClaimFiles = NODE_CLAIM_FILES,
): boolean {
  const staged = stagingPath(path);
  try {
    files.write(staged, lockText(lock));
  } catch (error) {
    throw new DevStateUnwritableError({ stateDir, error });
  }
  try {
    files.link(staged, path);
    return true;
  } catch (error) {
    // Same rule as `isProcessAlive` above: read the field, never cast and dereference.
    if (stringField(error, 'code') === 'EEXIST') return false;
    throw new DevStateUnwritableError({ stateDir, error });
  } finally {
    try {
      unlinkSync(staged);
    } catch {
      // Already gone; the staging name is unique to this call, so nothing else can need it.
    }
  }
}

/**
 * The lock's bytes right now, or `null` when there is no file to read. Total: a rival's steal may
 * remove the file between `exists()` and the read, and that is "absent", never a bare `ENOENT`.
 */
const readRaw = async (path: string): Promise<string | null> => {
  const file = Bun.file(path);
  try {
    return (await file.exists()) ? await file.text() : null;
  } catch {
    return null;
  }
};

/** Whatever is on disk right now, or `null` if it is absent or half-written. */
const readLock = async (path: string): Promise<DevLock | null> => {
  const raw = await readRaw(path);
  return raw === null ? null : parseLock(raw);
};

export interface PreflightInput {
  readonly stateDir: string;
  readonly port: number;
  /** The address the web role will bind. Probed exactly, never widened — see `isPortBound`. */
  readonly hostname: string;
  /** True when this checkout's database is the embedded one; only shapes the message. */
  readonly embeddedDb?: boolean;
  /** Injected by the test; `isPortBound` in production. */
  readonly portBound?: (port: number, hostname: string) => boolean;
  readonly alive?: (pid: number) => boolean;
  readonly holder?: (port: number) => Promise<PortHolder>;
  /** Injected by the test; `node:fs` in production. */
  readonly files?: ClaimFiles;
}

export interface PreflightResult {
  readonly clearedStale: boolean;
  /**
   * Give the directory back. The caller runs it when the boot it was preflighting FAILED —
   * `serve.ts`'s `releaseBoot` shape — because a claim held by a process that gave up refuses
   * every later boot in that shell for a pid that is gone.
   */
  release(): void;
}

/** Rounds of claim-or-clear before the lock is reported unreadable, and the wait on a busy steal. */
const CLAIM_ROUNDS = 200;
const STEAL_BUSY_MS = 5;

/**
 * The claim, clearing a stale lock on the way: `true` when one was cleared. Each round claims, or
 * reads the holder and refuses a live one, or clears a stale one under `dev.lock.steal`
 * (`stealStale`) and goes round again — so a lock that changed hands mid-round is judged afresh,
 * never deleted by path. A rival's fresh claim then reads as live and is refused; an unlink after
 * an unguarded read deleted it, and two boots shared one `.x/pgdata`.
 */
async function claimOrClearStale(
  input: PreflightInput,
  path: string,
  mine: DevLock,
  alive: (pid: number) => boolean,
): Promise<boolean> {
  let clearedStale = false;
  let held: DevLock | null = null;
  for (let round = 0; round < CLAIM_ROUNDS; round += 1) {
    if (claimExclusive(input.stateDir, path, mine, input.files)) return clearedStale;
    const raw = await readRaw(path);
    const now = raw === null ? null : parseLock(raw);
    // `held` keeps the last identity read: a half-written file parses as `null` for microseconds.
    held = now ?? held;
    if (now !== null && alive(now.pid) && !(await reusedPid(now))) {
      throw new DevAlreadyRunningError({
        lock: now,
        stateDir: input.stateDir,
        ...(input.embeddedDb === undefined ? {} : { embeddedDb: input.embeddedDb }),
      });
    }
    // Stale: a hard kill, or a file nothing here wrote. No bytes read (a directory at the lock's
    // path, say) leaves nothing to compare, so nothing is removed and the claim decides alone.
    clearedStale = true;
    if (raw === null) continue;
    const outcome = stealStale({
      path,
      judged: raw,
      claim: (guard) => claimExclusive(input.stateDir, guard, mine, input.files),
      alive: isProcessAlive,
    });
    if (outcome === 'busy') await Bun.sleep(STEAL_BUSY_MS);
  }
  // NEVER `mine`, which is what it fell back to: with an unparseable lock that could not be
  // cleared, both reads answered `null` and the refusal named THIS pid as the holder — `kill
  // <self>` as the remedy for a file nobody could read.
  const holder = (await readLock(path)) ?? held;
  if (holder === null) throw new DevLockUnreadableError({ path, stateDir: input.stateDir });
  throw new DevAlreadyRunningError({
    lock: holder,
    stateDir: input.stateDir,
    ...(input.embeddedDb === undefined ? {} : { embeddedDb: input.embeddedDb }),
  });
}

/**
 * Run before anything boots, and it CLAIMS: it returns holding the directory, never having merely
 * looked at it.
 *
 * That is the fix, not a detail. `preflight` read the lock, `startDev` booted for seconds, and
 * `writeLock` ran last — so two `x dev` in one checkout both passed the check and both opened
 * `.x/pgdata`, `X_DEV_ALREADY_RUNNING` was unreachable, and what the operator actually got was
 * `X_DB_UNAVAILABLE` whose `fix:` reads "run `x dev`" — the incident this file's own header
 * records. The claim closes the window it names.
 *
 * The stale path still exists and is still normal (a hard kill leaves a lock behind): the file is
 * removed (`claimOrClearStale`) and the claim retried. A retry that ALSO loses is another boot
 * that claimed the cleared slot in that instant, which is a refusal and not a third boot.
 */
export const preflight = async (input: PreflightInput): Promise<PreflightResult> => {
  const alive = input.alive ?? isProcessAlive;
  const bound = input.portBound ?? isPortBound;
  const path = lockPath(input.stateDir);
  const release = (): void => clearLock(input.stateDir);
  // The lock lives inside the state directory, which the database has not created yet — this runs
  // before anything boots, which is the whole point of it.
  try {
    mkdirSync(input.stateDir, { recursive: true });
  } catch (error) {
    throw new DevStateUnwritableError({ stateDir: input.stateDir, error });
  }
  const mine: DevLock = {
    pid: process.pid,
    port: input.port,
    // Refined by `writeLock` once the server reports the address it really bound; until then this
    // is what the refusal prints, and it is the address the boot is about to ask for.
    url: `http://${input.hostname}:${input.port}`,
    startedAt: new Date().toISOString(),
    ...(await startedOf(process.pid)),
  };
  const clearedStale = await claimOrClearStale(input, path, mine, alive);

  if (bound(input.port, input.hostname)) {
    // Released before the throw: the remedy this refusal prints is `x dev --port <n>`, and a claim
    // left behind would answer that command with X_DEV_ALREADY_RUNNING naming the process that
    // just exited on it.
    release();
    throw new DevPortInUseError({
      port: input.port,
      // `portPairAfter`, never `port + 1`: `x dev` binds a PAIR, so the holder is most often
      // another `x dev` whose sync role already sits on `port + 1`.
      suggestion: portPairAfter(input.port),
      holder: await (input.holder ?? portHolder)(input.port),
    });
  }
  return { clearedStale, release };
};

/**
 * Record this process. The claim is already on disk — `preflight` took it — so this REFINES it
 * with the address the server actually bound, which is the one field the preflight could not know.
 */
export const writeLock = async (stateDir: string, lock: DevLock): Promise<void> => {
  const stamped: DevLock =
    lock.started === undefined ? { ...lock, ...(await startedOf(lock.pid)) } : lock;
  // Staged and renamed over the claim, never rewritten in place: a truncate-then-write leaves an
  // empty lock for an instant, and a preflight reading it then would clear a live claim as stale.
  const path = lockPath(stateDir);
  const staged = stagingPath(path);
  writeFileSync(staged, lockText(stamped));
  renameSync(staged, path);
};

/** Remove it. Safe to call twice — shutdown paths overlap, and a throw here would mask the real one. */
export const clearLock = (stateDir: string): void => {
  try {
    unlinkSync(lockPath(stateDir));
  } catch {
    // Never written, already removed, or removed by a concurrent shutdown. Nothing to report.
  }
};
