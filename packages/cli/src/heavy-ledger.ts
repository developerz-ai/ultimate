// The machine's memory ledger: reservations weighted in MB, admitted first come, first served, every
// one a file its owner holds an flock on. A file nobody holds is dead by definition, so a holder or
// waiter killed by any signal stops counting at that instant and no take-over exists to race.
//
//   queue/<time>-<pid>-<id>   a waiter        holds/<pid>-<id>   an admitted reservation
//   gate                      the admission critical section; only the queue's head takes it
//
// A holder hands its locked descriptor to the workload, so the kernel frees a reservation only when
// the holder AND the workload are gone: killing a wrapper never frees memory its child still uses.
// Holders never wait while holding and children inherit the hold, so the ledger cannot deadlock.

// why: flock needs real descriptors, and Bun ships no descriptor-level file API.
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { HeavyLedgerUnavailableError, HeavyWaitExpiredError } from './heavy-errors';
import type { TryLock } from './heavy-flock';
import type { CpuReading } from './heavy-pressure';
import { cpuAdmission } from './heavy-pressure';

export const LEDGER_POLL_MS = 100;
/** A temp file this old lost its creator: creating one takes microseconds. */
const STALE_TEMP_MS = 60_000;

export interface LedgerEntry {
  readonly pid: number;
  readonly mb: number;
  readonly label: string;
  readonly cwd: string;
  readonly at: number;
}

/** An admitted reservation, and the file whose lock it is. */
export interface LedgerHold extends LedgerEntry {
  readonly file: string;
}

export interface LedgerView {
  readonly holds: readonly LedgerHold[];
  /** Oldest first: index 0 is the next admission. */
  readonly queue: readonly LedgerEntry[];
}

export interface Held {
  readonly path: string;
  /** The locked descriptor. Handed to a child, it keeps the lock for as long as the child lives. */
  readonly fd: number;
  release(): void;
}

export interface Reservation extends Held {
  readonly units: number;
  readonly mb: number;
  readonly waitedMs: number;
}

export interface ReserveInput {
  readonly dir: string;
  readonly capacityMb: number;
  /** MB one unit costs: a measured peak (`heavy-weights.ts`). */
  readonly unitMb: number;
  readonly units: number;
  /** MB the run costs however wide it is: the parent and whatever its workers share. */
  readonly baseMb?: number;
  /** Fewest units worth starting with. A run of workers narrows to what fits, down to this. */
  readonly minUnits?: number;
  readonly label: string;
  readonly cwd: string;
  readonly tryLock: TryLock;
  readonly pollMs?: number;
  /** Give up after this long in the queue. `0` is one attempt; unset waits for as long as it takes. */
  readonly maxWaitMs?: number;
  /** The CPU reading the head is judged by (`heavy-pressure.ts`); absent, CPU never holds it. */
  readonly cpu?: () => CpuReading;
  readonly onWait?: (wait: LedgerWait) => void;
}

export interface LedgerWait {
  readonly needMb: number;
  readonly usedMb: number;
  readonly capacityMb: number;
  readonly position: number;
  readonly queued: number;
  readonly holds: readonly LedgerEntry[];
  /** Set when memory fits and the CPU is what holds the head back. */
  readonly cpu?: CpuReading;
}

const codeOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
  }
}

function once(run: () => void): () => void {
  let spent = false;
  return () => {
    if (spent) return;
    spent = true;
    run();
  };
}

export function prepareLedger(dir: string): void {
  for (const sub of ['queue', 'holds', 'locks']) {
    mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
  }
}

const parseEntry = (text: string): LedgerEntry | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return undefined;
    const field = (name: string): unknown => Reflect.get(value, name);
    const [pid, mb, at] = [field('pid'), field('mb'), field('at')];
    if (typeof pid !== 'number' || typeof mb !== 'number' || typeof at !== 'number') {
      return undefined;
    }
    return { pid, mb, at, label: String(field('label')), cwd: String(field('cwd')) };
  } catch {
    return undefined;
  }
};

interface Live {
  readonly name: string;
  readonly entry: LedgerEntry;
}

/** The entries whose owner still holds their lock, in name order. A dead one is dropped. */
function liveEntries(dir: string, tryLock: TryLock, sweep: boolean): Live[] {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return [];
    throw error;
  }
  const live: Live[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch (error) {
      if (codeOf(error) === 'ENOENT') continue;
      throw error;
    }
    try {
      if (tryLock(fd)) {
        if (sweep) unlinkQuiet(path);
        continue;
      }
      const entry = parseEntry(readFileSync(fd, 'utf8'));
      if (entry !== undefined) live.push({ name, entry });
    } finally {
      closeSync(fd);
    }
  }
  return live;
}

export const readLedger = (dir: string, tryLock: TryLock): LedgerView => ({
  holds: liveEntries(join(dir, 'holds'), tryLock, false).map((one) => ({
    ...one.entry,
    file: join(dir, 'holds', one.name),
  })),
  queue: liveEntries(join(dir, 'queue'), tryLock, false).map((one) => one.entry),
});

/** Whether the file at `path` is a reservation some live process still holds. */
export function isHeld(path: string, tryLock: TryLock): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return false;
  }
  try {
    return !tryLock(fd);
  } finally {
    closeSync(fd);
  }
}

/** Created under a temp name, locked, THEN renamed in: no live entry is ever visible unlocked. */
function createEntry(root: string, sub: string, name: string, entry: LedgerEntry, lock: TryLock) {
  const temp = join(root, `tmp-${name}`);
  const fd = openSync(temp, 'wx');
  if (!lock(fd)) {
    closeSync(fd);
    unlinkQuiet(temp);
    return undefined;
  }
  writeSync(fd, JSON.stringify(entry));
  const path = join(root, sub, name);
  renameSync(temp, path);
  // Unlink before close: the lock must outlast the file, or a sweeper could judge it dead.
  return {
    path,
    fd,
    release: once(() => {
      unlinkQuiet(path);
      closeSync(fd);
    }),
  };
}

function sweepTemps(root: string, now: number): void {
  for (const name of readdirSync(root)) {
    if (!name.startsWith('tmp-')) continue;
    const path = join(root, name);
    try {
      if (now - statSync(path).mtimeMs > STALE_TEMP_MS) unlinkQuiet(path);
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error;
    }
  }
}

/** A short exclusive lock on `path`, or nothing when another descriptor has it. */
export function tryLockPath(path: string, label: string, tryLock: TryLock): Held | undefined {
  const fd = openSync(path, 'a');
  let held = false;
  try {
    held = tryLock(fd);
  } finally {
    if (!held) closeSync(fd);
  }
  if (!held) return undefined;
  ftruncateSync(fd, 0);
  writeSync(fd, `pid ${String(process.pid)}: ${label}\n`);
  return { path, fd, release: once(() => closeSync(fd)) };
}

/** Wait for `path`. `onWait` is told once, with whoever the file names as its holder. */
export async function lockPath(
  path: string,
  label: string,
  tryLock: TryLock,
  onWait?: (holder: string) => void,
  pollMs: number = LEDGER_POLL_MS,
): Promise<Held> {
  let told = false;
  for (;;) {
    const held = tryLockPath(path, label, tryLock);
    if (held !== undefined) return held;
    if (!told) {
      told = true;
      onWait?.(readFileSync(path, 'utf8').trim() || 'an unnamed holder');
    }
    await Bun.sleep(pollMs);
  }
}

const unique = (): string => `${String(process.pid)}-${crypto.randomUUID()}`;

/** How many units fit now, or 0 when even `min` does not. Too big for the ledger runs alone. */
export function unitsThatFit(input: {
  readonly capacityMb: number;
  readonly usedMb: number;
  readonly unitMb: number;
  readonly units: number;
  readonly minUnits: number;
  readonly baseMb?: number;
}): number {
  const { usedMb, unitMb, units } = input;
  const capacityMb = input.capacityMb - (input.baseMb ?? 0);
  const most = Math.max(1, Math.floor(capacityMb / unitMb));
  const want = Math.min(units, most);
  const min = Math.min(input.minUnits, want);
  if (usedMb === 0) return want;
  const fit = Math.min(want, Math.floor((capacityMb - usedMb) / unitMb));
  return fit >= min ? fit : 0;
}

/**
 * Join the queue and return once admitted. First come, first served: only the head may admit, so a
 * big request is never starved by small ones slipping past it. The gate is held for one check at a
 * time and never across a wait, so a head that dies leaves nothing behind.
 */
export async function reserve(input: ReserveInput): Promise<Reservation> {
  const { dir, tryLock, capacityMb, unitMb, units } = input;
  const baseMb = input.baseMb ?? 0;
  // A NaN passes `??` and would turn the wait into a spin on the ledger directory.
  const pollMs = Number.isFinite(input.pollMs) ? (input.pollMs as number) : LEDGER_POLL_MS;
  prepareLedger(dir);
  const started = performance.now();
  const base = { pid: process.pid, label: input.label, cwd: input.cwd };
  const name = `${String(Date.now()).padStart(15, '0')}-${unique()}`;
  const ticket = createEntry(
    dir,
    'queue',
    name,
    { ...base, mb: baseMb + units * unitMb, at: Date.now() },
    tryLock,
  );
  if (ticket === undefined) throw new HeavyLedgerUnavailableError('a new queue file was locked');
  const minUnits = input.minUnits ?? 1;
  let said = '';
  /** When the head started waiting on CPU alone: `CPU_WAIT_LIMIT_MS` is counted from here. */
  let cpuBlockedAt: number | undefined;
  try {
    for (;;) {
      let cpu: CpuReading | undefined;
      const queue = liveEntries(join(dir, 'queue'), tryLock, true);
      const position = queue.findIndex((one) => one.name === name);
      if (position === -1) throw new HeavyLedgerUnavailableError(`${dir} was removed mid-wait`);
      let holds = liveEntries(join(dir, 'holds'), tryLock, position === 0);
      if (position === 0) {
        const gate = tryLockPath(join(dir, 'gate'), input.label, tryLock);
        if (gate !== undefined) {
          try {
            sweepTemps(dir, Date.now());
            // Re-read under the gate: an admission may have landed since the read above.
            holds = liveEntries(join(dir, 'holds'), tryLock, true);
            const usedMb = holds.reduce((sum, one) => sum + one.entry.mb, 0);
            const granted = unitsThatFit({ capacityMb, usedMb, unitMb, units, minUnits, baseMb });
            const reading = granted > 0 ? input.cpu?.() : undefined;
            const now = performance.now();
            const verdict = cpuAdmission({
              reading,
              running: holds.length,
              blockedMs: cpuBlockedAt === undefined ? 0 : now - cpuBlockedAt,
            });
            if (granted > 0 && verdict === 'wait') {
              cpuBlockedAt ??= now;
              cpu = reading;
            } else cpuBlockedAt = undefined;
            if (granted > 0 && verdict === 'admit') {
              const mb = baseMb + granted * unitMb;
              const hold = createEntry(
                dir,
                'holds',
                unique(),
                { ...base, mb, at: Date.now() },
                tryLock,
              );
              if (hold === undefined) {
                throw new HeavyLedgerUnavailableError('a new reservation file was locked');
              }
              return {
                ...hold,
                units: granted,
                mb,
                waitedMs: Math.round(performance.now() - started),
              };
            }
          } finally {
            gate.release();
          }
        }
      }
      const usedMb = holds.reduce((sum, one) => sum + one.entry.mb, 0);
      // Behind the head, the queue is held by whatever holds the head: say CPU when that is it.
      if (cpu === undefined && position > 0 && holds.length > 0) {
        const reading = input.cpu?.();
        if (reading?.busy === true) cpu = reading;
      }
      const wait: LedgerWait = {
        needMb: Math.min(baseMb + units * unitMb, capacityMb),
        usedMb,
        capacityMb,
        position: position + 1,
        queued: queue.length,
        holds: holds.map((one) => one.entry),
        ...(cpu === undefined ? {} : { cpu }),
      };
      const key = `${String(position)}|${cpu === undefined ? '' : 'cpu'}|${holds.map((one) => one.name).join(',')}`;
      if (key !== said) {
        said = key;
        input.onWait?.(wait);
      }
      const { maxWaitMs } = input;
      const left = (maxWaitMs ?? Number.POSITIVE_INFINITY) - (performance.now() - started);
      if (maxWaitMs !== undefined && left <= 0) {
        throw new HeavyWaitExpiredError({ label: input.label, maxWaitMs, wait });
      }
      await Bun.sleep(Math.min(pollMs, left));
    }
  } finally {
    ticket.release();
  }
}
