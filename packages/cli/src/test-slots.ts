// The MACHINE's test budget, shared by every `x test` and `x verify` running on it at once.
//
// A run's own width (`test-workers.ts`) bounds one run. It cannot bound two: on 2026-09-27 two
// agents' gates on one 45 GB box each planned 14-18 workers off the same free-memory reading and
// the kernel OOM-killed the machine with 36 `bun` processes holding ~40 GB. So each batch of
// workers first LEASES that many slots from a pool of lock files — one file per worker the machine
// budget allows — and a second run on the same box gets what is left: it runs narrower, or waits
// for one slot, instead of doubling the machine's memory.
//
// A slot is a file created with O_EXCL holding the leasing process's pid. A holder that died
// without releasing (SIGKILL, OOM, a closed terminal) is detected by its pid no longer existing,
// and its slot is taken over. Nothing here needs a daemon, and nothing survives a reboot that
// matters: the directory is under the OS temp dir.
//
// Bun ships no O_EXCL create and no pid probe: `openSync(…, 'wx')` and `process.kill(pid, 0)` are
// the node:fs / process primitives for exactly those two.
// why: Bun ships no O_EXCL create (writeFileSync flag 'wx') and no sync unlink/mkdir.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';

/** Where the pool lives. Per user, so two accounts on one box never read each other's pids. */
export const SLOTS_DIR_ENV = 'ULTIMATE_TEST_SLOTS_DIR';

/** `0` turns the machine pool off — a CI runner that runs one job per VM has nothing to share. */
export const SLOTS_ENV = 'ULTIMATE_TEST_SLOTS';

/**
 * Set on every `bun test` a leased batch spawns: the slots are already held for that process
 * tree, so an `x test` / `x verify` a test runs inside it (the framework's own suites do) must
 * not lease again — it would wait on its own parent's slots.
 */
export const SLOT_HELD_ENV = 'ULTIMATE_TEST_SLOT_HELD';

/** How long a run waits for its first slot before it runs one worker anyway, and says so. */
export const SLOT_WAIT_MS = 10 * 60 * 1000;

const POLL_MS = 500;

type Env = Readonly<Record<string, string | undefined>>;

export const slotsDir = (env: Env = Bun.env): string =>
  env[SLOTS_DIR_ENV] ??
  join(tmpdir(), `ultimate-test-slots-${String(process.getuid?.() ?? 'user')}`);

export const slotsEnabled = (env: Env = Bun.env): boolean =>
  env[SLOTS_ENV] !== '0' && env[SLOT_HELD_ENV] !== '1' && Bun.env[SLOT_HELD_ENV] !== '1';

/** A lease on `count` workers' worth of the machine. `count` is at least 1. */
export interface SlotLease {
  readonly count: number;
  /** Slots actually held — 0 when the wait ran out and the run went ahead unleased. */
  readonly held: number;
  /** How long the lease waited for its first slot. */
  readonly waitedMs: number;
  release(): void;
}

const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is a live process another user owns — alive, and not ours to take.
    return (error as { code?: string } | null)?.code === 'EPERM';
  }
};

export interface AcquireInput {
  /** Workers this batch wants. */
  readonly want: number;
  /** Slots the machine budget allows in all — `defaultWorkers()` for this box. */
  readonly capacity: number;
  readonly dir?: string;
  readonly pid?: number;
  readonly alive?: (pid: number) => boolean;
  readonly waitMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** Take one slot file, or take it over from a dead holder. */
function tryTake(path: string, pid: number, alive: (pid: number) => boolean): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, String(pid), { flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== 'EEXIST') return false;
    }
    let holder: number;
    try {
      holder = Number.parseInt(readFileSync(path, 'utf8'), 10);
    } catch {
      // Released between the create and the read: try the create once more.
      continue;
    }
    if (alive(holder)) return false;
    try {
      unlinkSync(path);
    } catch {
      // Another run took it over first; the second create decides.
    }
  }
  return false;
}

/**
 * Lease up to `want` slots out of `capacity`. Never zero: with every slot held, it polls until one
 * frees, and after `waitMs` it runs one worker unleased rather than hang a gate forever.
 */
export async function acquireSlots(input: AcquireInput): Promise<SlotLease> {
  const dir = input.dir ?? slotsDir();
  const pid = input.pid ?? process.pid;
  const alive = input.alive ?? pidAlive;
  const sleep = input.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = input.now ?? (() => performance.now());
  const want = Math.max(1, Math.trunc(input.want));
  const capacity = Math.max(1, Math.trunc(input.capacity));
  mkdirSync(dir, { recursive: true });
  const started = now();
  const waitMs =
    input.waitMs !== undefined && Number.isFinite(input.waitMs) && input.waitMs >= 0
      ? input.waitMs
      : SLOT_WAIT_MS;
  const deadline = started + waitMs;
  for (;;) {
    const held: string[] = [];
    for (let index = 0; index < capacity && held.length < want; index += 1) {
      const path = join(dir, `slot-${String(index)}`);
      if (tryTake(path, pid, alive)) held.push(path);
    }
    if (held.length > 0 || now() >= deadline) {
      const waitedMs = Math.round(now() - started);
      let released = false;
      return {
        count: Math.max(1, held.length),
        held: held.length,
        waitedMs,
        release: () => {
          if (released) return;
          released = true;
          for (const path of held) {
            try {
              if (readFileSync(path, 'utf8') === String(pid)) unlinkSync(path);
            } catch {
              // Already gone — a crashed-holder sweep by another run took it.
            }
          }
        },
      };
    }
    await sleep(POLL_MS);
  }
}

/**
 * The lease a default-width run takes per batch, or none: an explicit `--workers` is the caller's
 * call (as it is over the budget), and `ULTIMATE_TEST_SLOTS=0` turns the pool off.
 */
export const machineLease = (
  capacity: number,
  env: Env = Bun.env,
): ((want: number) => Promise<SlotLease>) | undefined =>
  slotsEnabled(env) ? (want) => acquireSlots({ want, capacity, dir: slotsDir(env) }) : undefined;
