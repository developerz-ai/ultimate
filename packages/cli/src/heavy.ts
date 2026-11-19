// Admission to the machine, as the rest of the CLI sees it: whether the ledger applies to this
// process, and the three ways in. Never a reason for work to fail: a ledger that cannot run is said
// once on stderr and the command goes ahead.

// why: Bun ships no lstat with ownership, and the fixed path below needs one.
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { isUltimateError } from '@ultimat3/core';
import { coreCap, nativeToolEnv } from './heavy-cores';
import type { HeavyEnv } from './heavy-env';
import { HEAVY_DIR_ENV, HEAVY_HOLD_ENV, isCi } from './heavy-env';
import { HeavyLedgerUnavailableError, HeavyWaitExpiredError } from './heavy-errors';
import type { TryLock } from './heavy-flock';
import { flockBinding } from './heavy-flock';
import type { Held, LedgerEntry, LedgerWait, Reservation } from './heavy-ledger';
import { isHeld, lockPath, prepareLedger, reserve } from './heavy-ledger';
import { ledgerCapacityMb } from './heavy-memory';
import { cpuGateOn, cpuText, readCpuPressure } from './heavy-pressure';
import { msg } from './messages';
import { writeErrorLine } from './write-line';

export type HeavyOff = 'ci' | 'test-run' | 'disabled' | 'nested' | 'unsupported';

export type HeavyState =
  | {
      readonly on: true;
      readonly dir: string;
      readonly capacityMb: number;
      readonly tryLock: TryLock;
    }
  | { readonly on: false; readonly off: HeavyOff; readonly detail?: string };

/** One per machine and uid. A FIXED path: `TMPDIR` differs per session, and two ledgers are no bound. */
export const defaultLedgerDir = (uid: number | undefined = process.getuid?.()): string =>
  `/tmp/ultimate-heavy-${String(uid ?? 0)}`;

/** `/tmp` is world-writable: refuse a directory someone else planted at our fixed path. */
function requireOwnDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || (process.getuid !== undefined && stat.uid !== process.getuid())) {
    throw new HeavyLedgerUnavailableError(`${dir} is not a directory this user owns`);
  }
  prepareLedger(dir);
}

const said = new Set<string>();
const warnOnce = (line: string): void => {
  if (said.has(line)) return;
  said.add(line);
  writeErrorLine(line);
};

const describe = (error: unknown): string =>
  isUltimateError(error)
    ? `${error.code}: ${error.cause}\n  fix: ${error.fix}`
    : new HeavyLedgerUnavailableError(error instanceof Error ? error.message : 'unknown').message;

/** Whether admission applies here. Throws only coded errors; `admission` turns them into a line. */
export async function heavyState(env: HeavyEnv): Promise<HeavyState> {
  if (isCi(env)) return { on: false, off: 'ci' };
  const explicitDir = env[HEAVY_DIR_ENV];
  // A fixture's `x test` runs inside `bun test`, whose NODE_ENV every child inherits: queueing it
  // behind real work would turn a test's timeout into a machine-load verdict. `Bun.env` as well: a
  // fixture calling in-process with its own small env is just as much inside the test run, and a
  // timed-out one left its ticket at the head of the machine's queue until the worker exited.
  const inTestRun = env['NODE_ENV'] === 'test' || Bun.env['NODE_ENV'] === 'test';
  if (inTestRun && explicitDir === undefined) return { on: false, off: 'test-run' };
  const capacityMb = ledgerCapacityMb(env);
  if (capacityMb === 0) return { on: false, off: 'disabled' };
  const binding = await flockBinding();
  if (!binding.ok) return { on: false, off: 'unsupported', detail: binding.reason };
  const hold = env[HEAVY_HOLD_ENV];
  if (hold !== undefined && hold !== '' && isHeld(hold, binding.tryLock)) {
    return { on: false, off: 'nested' };
  }
  const dir = explicitDir ?? defaultLedgerDir();
  requireOwnDir(dir);
  return { on: true, dir, capacityMb, tryLock: binding.tryLock };
}

async function admission(env: HeavyEnv): Promise<HeavyState> {
  try {
    return await heavyState(env);
  } catch (error) {
    warnOnce(describe(error));
    return { on: false, off: 'unsupported', detail: 'see the line above' };
  }
}

const PATH_SHOWN = 48;
const printable = (text: string): string => text.replace(/\p{Cc}/gu, ' ').slice(0, 120);

export const ageOf = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60
    ? `${String(seconds)}s`
    : `${String(Math.floor(seconds / 60))}m${String(seconds % 60).padStart(2, '0')}s`;
};

/** A directory's END names the checkout; a long path keeps that and loses its start. */
const shortPath = (path: string): string =>
  path.length <= PATH_SHOWN ? printable(path) : `…${printable(path.slice(-PATH_SHOWN))}`;

export const describeEntry = (entry: LedgerEntry, now: number): string =>
  `${printable(entry.label)} (${shortPath(entry.cwd)}, ${String(entry.mb)} MB, ${ageOf(now - entry.at)})`;

/** The waiter's one line. Stderr always: stdout may be a `--json` document. */
export const waitLine = (label: string, wait: LedgerWait, now: number = Date.now()): string =>
  // No holder to name is the instant between two admissions, not a mystery owner.
  msg(
    wait.cpu !== undefined
      ? 'cli.heavy.waitingCpu'
      : wait.holds.length === 0
        ? 'cli.heavy.waitingAdmission'
        : 'cli.heavy.waiting',
    {
      label: printable(label),
      need: wait.needMb,
      position: wait.position,
      queued: wait.queued,
      used: wait.usedMb,
      capacity: wait.capacityMb,
      holders: wait.holds.map((entry) => describeEntry(entry, now)).join('; '),
      cpu: wait.cpu === undefined ? '' : cpuText(wait.cpu),
    },
  );

// Time this process has spent queued, so a gate step's deadline can stop counting it.
let finishedWaitMs = 0;
const waitStarts = new Set<number>();

/** Monotonic milliseconds spent waiting for admission, ongoing waits included. */
export const heavyWaitClock = (now: number = performance.now()): number => {
  let total = finishedWaitMs;
  for (const start of waitStarts) total += now - start;
  return total;
};

async function timedWait<T>(wait: () => Promise<T>): Promise<T> {
  const start = performance.now();
  waitStarts.add(start);
  try {
    return await wait();
  } finally {
    waitStarts.delete(start);
    finishedWaitMs += performance.now() - start;
  }
}

export interface HeavyRequest {
  readonly label: string;
  readonly cwd: string;
  readonly env: HeavyEnv;
  readonly unitMb: number;
  readonly baseMb?: number;
  readonly units?: number;
  readonly minUnits?: number;
  /** Give up after this long in the queue (`x heavy run --max-wait`). */
  readonly maxWaitMs?: number;
}

/** A reservation, or nothing when admission does not apply or could not work. */
async function enter(request: HeavyRequest, state: HeavyState): Promise<Reservation | undefined> {
  if (!state.on) return undefined;
  try {
    return await timedWait(() =>
      reserve({
        dir: state.dir,
        capacityMb: state.capacityMb,
        tryLock: state.tryLock,
        unitMb: request.unitMb,
        ...(request.baseMb === undefined ? {} : { baseMb: request.baseMb }),
        units: request.units ?? 1,
        minUnits: request.minUnits ?? request.units ?? 1,
        ...(request.maxWaitMs === undefined ? {} : { maxWaitMs: request.maxWaitMs }),
        ...(cpuGateOn(request.env) ? { cpu: () => readCpuPressure() } : {}),
        label: request.label,
        cwd: request.cwd,
        onWait: (wait) => writeErrorLine(waitLine(request.label, wait)),
      }),
    );
  } catch (error) {
    // The caller set this bound: running anyway, unadmitted, is what it asked not to happen.
    if (error instanceof HeavyWaitExpiredError) throw error;
    warnOnce(describe(error));
    return undefined;
  }
}

/** What a holder's child is spawned with: the hold's name, and the locks it must keep alive. */
export interface HeavyChild {
  readonly env: Readonly<Record<string, string>>;
  readonly fds: readonly number[];
}

const childOf = (env: HeavyEnv, state: HeavyState, held: Held | undefined): HeavyChild => ({
  env: {
    ...toolEnv(env, state),
    ...(held === undefined ? {} : { [HEAVY_HOLD_ENV]: held.path }),
  },
  fds: held === undefined ? [] : [held.fd],
});

/** What a native tool's child is spawned with: the thread cap, unless this run has no ceiling. */
function toolEnv(env: HeavyEnv, state: HeavyState): Record<string, string> {
  const capped = state.on || state.off === 'nested' || state.off === 'unsupported';
  return capped ? nativeToolEnv(env, coreCap(env)) : {};
}

/** Runner options carrying `child`; untouched when it adds nothing, as under CI and in a test. */
export function withChild<T extends { readonly cwd: string }>(
  options: T,
  child: HeavyChild,
):
  | T
  | (T & {
      readonly env: Readonly<Record<string, string>>;
      readonly inheritFds: readonly number[];
    }) {
  return Object.keys(child.env).length === 0 && child.fds.length === 0
    ? options
    : { ...options, env: child.env, inheritFds: child.fds };
}

/** Run `work` inside one reservation; everything it spawns gets `child`. */
export async function withHeavy<T>(
  request: HeavyRequest,
  work: (child: HeavyChild) => Promise<T>,
): Promise<T> {
  const state = await admission(request.env);
  const held = await enter(request, state);
  try {
    return await work(childOf(request.env, state, held));
  } finally {
    held?.release();
  }
}

/** `name` for one checkout, whichever path reached it, in the ledger's directory. */
const checkoutLockPath = (dir: string, name: string, root: string): string =>
  join(dir, 'locks', `${name}-${Bun.hash(realpathSync(root)).toString(36)}.lock`);

/**
 * One `name` at a time in this checkout (two `tsc -b` race one `dist/`). Taken AFTER the ledger, by
 * every caller: a process holding this lock must never queue for memory, or a nested run holding
 * memory and waiting for the lock would close a cycle.
 */
export async function withCheckoutLock<T>(
  input: { readonly name: string; readonly root: string; readonly env: HeavyEnv },
  child: HeavyChild,
  work: (child: HeavyChild) => Promise<T>,
): Promise<T> {
  // Nested runs still exclude each other here, so the state's `nested` is not an exemption.
  const state = await admission({ ...input.env, [HEAVY_HOLD_ENV]: undefined });
  if (!state.on) return work(child);
  let held: Held | undefined;
  try {
    const path = checkoutLockPath(state.dir, input.name, input.root);
    held = await timedWait(() =>
      lockPath(path, `${input.name} in ${input.root}`, state.tryLock, (holder) =>
        writeErrorLine(msg('cli.heavy.lockWait', { name: input.name, holder: printable(holder) })),
      ),
    );
  } catch (error) {
    warnOnce(describe(error));
  }
  try {
    // The compiler keeps the lock too: a killed wrapper must not let a second one start beside it.
    return await work(held === undefined ? child : { ...child, fds: [...child.fds, held.fd] });
  } finally {
    held?.release();
  }
}

export interface WorkerLease {
  readonly count: number;
  readonly env?: Readonly<Record<string, string>>;
  /** Locked descriptors each worker process must inherit. */
  readonly fds?: readonly number[];
  release(): void;
}

/**
 * Up to `want` test workers, as many as the core cap and the ledger allow right now, at least one.
 * `exact` is an explicit `--workers`: the caller's width, and it waits for all of it.
 */
export async function leaseWorkers(
  want: number,
  request: Omit<HeavyRequest, 'units' | 'minUnits'> & { readonly exact?: boolean },
): Promise<WorkerLease> {
  const state = await admission(request.env);
  const unbounded = !state.on && state.off !== 'nested' && state.off !== 'unsupported';
  const cap = request.exact === true || unbounded ? undefined : coreCap(request.env);
  const units = Math.max(1, cap === undefined ? want : Math.min(want, cap));
  const held = await enter(
    { ...request, units, minUnits: request.exact === true ? units : 1 },
    state,
  );
  const child = childOf(request.env, state, held);
  return {
    count: held?.units ?? units,
    env: child.env,
    fds: child.fds,
    release: () => held?.release(),
  };
}
