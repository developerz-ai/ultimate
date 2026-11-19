// What the ledger may admit: half of the memory this process can really use. `totalmem()` is the
// host's figure, so inside a capped cgroup it plans for memory the kernel will never grant; the
// binding limit is the smallest `memory.max` along this process's own cgroup-v2 ancestry.

// why: Bun ships no synchronous file read, and `/proc` and `/sys` must be read at their real size.
import { readFileSync } from 'node:fs';
// why: Bun exposes no total-memory or free-memory primitive.
import { freemem, totalmem } from 'node:os';
import type { HeavyEnv } from './heavy-env';
import { HEAVY_MEMORY_ENV } from './heavy-env';
import { HeavyMemoryInvalidError } from './heavy-errors';
import { parseBytes } from './test-workers';

/** RAM's other half stays for the agent sessions, editors and servers no ledger can see. */
export const LEDGER_SHARE = 0.5;

const CGROUP_ROOT = '/sys/fs/cgroup';
const MIB = 2 ** 20;

export type ReadFile = (path: string) => string | undefined;

const readOrNothing: ReadFile = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

/** The smallest numeric `memory.max` from the mount root down to this process's cgroup. */
export function cgroupLimitBytes(read: ReadFile = readOrNothing): number | undefined {
  const line = read('/proc/self/cgroup')
    ?.split('\n')
    .find((candidate) => candidate.startsWith('0::'));
  if (line === undefined) return undefined;
  const limits: number[] = [];
  let dir = CGROUP_ROOT;
  // The root counts: inside a container the namespace shows `/` and the limit sits on the mount.
  for (const part of ['', ...line.slice(3).trim().split('/').filter(Boolean)]) {
    if (part !== '') dir = `${dir}/${part}`;
    const raw = read(`${dir}/memory.max`)?.trim();
    if (raw !== undefined && /^\d+$/.test(raw)) limits.push(Number(raw));
  }
  return limits.length === 0 ? undefined : Math.min(...limits);
}

/** The machine as this process may use it, bytes. */
export const usableMemoryBytes = (
  host: number = totalmem(),
  limit: number | undefined = cgroupLimitBytes(),
): number => (limit === undefined ? host : Math.min(host, limit));

/** MB the ledger admits; 0 means it is off. Throws `X_HEAVY_MEMORY_INVALID` on a bad override. */
export function ledgerCapacityMb(env: HeavyEnv, usable: number = usableMemoryBytes()): number {
  const raw = env[HEAVY_MEMORY_ENV]?.trim();
  if (raw === undefined || raw === '') return Math.floor((usable * LEDGER_SHARE) / MIB);
  if (raw === '0') return 0;
  const bytes = parseBytes(raw);
  if (bytes === undefined) throw new HeavyMemoryInvalidError(raw);
  return Math.max(1, Math.floor(bytes / MIB));
}

/** Memory a new process could get now: `MemAvailable` where Linux reports it. */
export function availableMemoryBytes(read: ReadFile = readOrNothing): number {
  const match = /^MemAvailable:\s+(\d+) kB/m.exec(read('/proc/meminfo') ?? '');
  return match === null ? freemem() : Number(match[1]) * 1024;
}
