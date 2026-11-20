// What the container's cgroup DECLARES: a CPU budget and a memory ceiling. Read from the files, not
// from `navigator.hardwareConcurrency`, because that answers every host core when no quota is set
// (`cpu.max = max`), and "undeclared" must read as one process, never as the node's core count.

/** A file's text, or `undefined` when it does not exist or cannot be read: a fact, not a failure. */
export type ReadText = (path: string) => Promise<string | undefined>;

export const readText: ReadText = async (path) => {
  try {
    const file = Bun.file(path);
    return (await file.exists()) ? await file.text() : undefined;
  } catch {
    return undefined;
  }
};

export const CGROUP_PATHS = Object.freeze({
  cpuMax: '/sys/fs/cgroup/cpu.max',
  cfsQuota: '/sys/fs/cgroup/cpu/cpu.cfs_quota_us',
  cfsPeriod: '/sys/fs/cgroup/cpu/cpu.cfs_period_us',
  memoryMax: '/sys/fs/cgroup/memory.max',
  memoryLimit: '/sys/fs/cgroup/memory/memory.limit_in_bytes',
});

/** cgroup v1 writes "unlimited" as the largest page-aligned 63-bit value; anything this big is none. */
const V1_UNLIMITED_FLOOR = 2 ** 62;

const positive = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined;
  const value = Number(text.trim());
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

/** Whole CPUs a quota buys, floored, at least 1. `--cpus=1.5` is 1: the safe answer. */
const wholeCpus = (quota: number, period: number): number =>
  Math.max(1, Math.floor(quota / period));

/**
 * cgroup v2 `cpu.max` (`"<quota> <period>"` or `"max <period>"`), else v1's CFS pair (quota `-1` is
 * none). `undefined` = no budget declared. A v2 file saying `max` is the answer: v1 is not asked.
 */
export function cpuBudget(
  cpuMax: string | undefined,
  cfsQuota?: string,
  cfsPeriod?: string,
): number | undefined {
  if (cpuMax !== undefined) {
    const [quota, period] = cpuMax.trim().split(/\s+/);
    const q = positive(quota);
    const p = positive(period);
    return q === undefined || p === undefined ? undefined : wholeCpus(q, p);
  }
  const q = positive(cfsQuota);
  const p = positive(cfsPeriod);
  return q === undefined || p === undefined ? undefined : wholeCpus(q, p);
}

/** Bytes the container may hold: v2 `memory.max` (`max` is none), else v1's limit. */
export function memoryCeiling(memoryMax: string | undefined, v1Limit?: string): number | undefined {
  if (memoryMax !== undefined) return positive(memoryMax);
  const limit = positive(v1Limit);
  return limit === undefined || limit >= V1_UNLIMITED_FLOOR ? undefined : limit;
}

export interface CgroupFacts {
  /** Whole CPUs the quota declares; `undefined` when none is. */
  readonly cpus: number | undefined;
  /** The memory ceiling in bytes; `undefined` when unlimited. */
  readonly memoryBytes: number | undefined;
}

export async function readCgroup(read: ReadText = readText): Promise<CgroupFacts> {
  const [cpuMax, cfsQuota, cfsPeriod, memoryMax, memoryLimit] = await Promise.all([
    read(CGROUP_PATHS.cpuMax),
    read(CGROUP_PATHS.cfsQuota),
    read(CGROUP_PATHS.cfsPeriod),
    read(CGROUP_PATHS.memoryMax),
    read(CGROUP_PATHS.memoryLimit),
  ]);
  return {
    cpus: cpuBudget(cpuMax, cfsQuota, cfsPeriod),
    memoryBytes: memoryCeiling(memoryMax, memoryLimit),
  };
}
