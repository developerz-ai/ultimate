// `x verify --only <step> --shard i/n`: one CI job's slice of a parallel test step, and the facts
// `x verify merge` needs to prove that n jobs' slices were the whole corpus exactly once.
//
// The split is a PURE function of the sorted file list, n and (optionally) a timings file — never
// of the machine, the clock or the order a glob yielded — so job 3 of 8 is the same files on every
// runner, and a failing shard reproduces locally with the same flags.

import { renderFixShellArg } from '@ultimat3/core';
import { CryptoHasher } from 'bun';
import type { ShardFacts } from './output';
import { VerifyShardInvalidError } from './verify-errors';
import type { VerifyStepName } from './verify-step';

/** The steps a shard may split: the parallel suites. `live` and `e2e` are serial by design. */
export const SHARDABLE_STEPS: readonly VerifyStepName[] = ['unit', 'contract', 'job'];

export interface ShardSpec {
  /** 1-based, as a CI matrix counts. */
  readonly index: number;
  readonly total: number;
}

/** `3/8` → `{ index: 3, total: 8 }`, refused unless `1 <= i <= n`. */
export function parseShard(raw: string): ShardSpec {
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(raw);
  const index = match === null ? Number.NaN : Number(match[1]);
  const total = match === null ? Number.NaN : Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total < 1 || index < 1) {
    throw new VerifyShardInvalidError({ reason: `"${raw}" is not i/n (e.g. 2/4)` });
  }
  if (index > total) {
    throw new VerifyShardInvalidError({
      reason: `shard ${String(index)} does not exist in a ${String(total)}-way split (1..${String(total)})`,
      fix: `x verify --only unit --shard ${renderFixShellArg(`${String(total)}/${String(total)}`, '<i/n>')} --json`,
    });
  }
  return { index, total };
}

/**
 * The steps a shard run may name: every one must be shardable. Refused with the step named, and a
 * fix that keeps the shardable ones — `live`/`e2e` belong in a job of their own.
 */
export function assertShardable(only: readonly VerifyStepName[] | undefined): void {
  if (only === undefined || only.length === 0) {
    throw new VerifyShardInvalidError({
      reason: 'a shard is one slice of ONE parallel step and needs --only to name it',
      fix: 'x verify --only unit --shard 1/4 --json',
    });
  }
  const refused = only.filter((step) => !SHARDABLE_STEPS.includes(step));
  if (refused.length > 0) {
    const kept = only.filter((step) => SHARDABLE_STEPS.includes(step));
    throw new VerifyShardInvalidError({
      reason: `${refused.join(', ')} cannot be split (only ${SHARDABLE_STEPS.join(', ')}); run ${
        refused.length === 1 ? 'it' : 'them'
      } in a job of its own without --shard`,
      fix:
        kept.length === 0
          ? `x verify --only ${renderFixShellArg(refused.join(','), '<step,step>')} --json`
          : `x verify --only ${renderFixShellArg(kept.join(','), '<step,step>')} --shard 1/4 --json`,
    });
  }
}

/** sha256 of the sorted list, one path a line: equal across shards iff they split one corpus. */
export const corpusHash = (files: readonly string[]): string => {
  const hasher = new CryptoHasher('sha256');
  hasher.update([...files].sort().join('\n'));
  return hasher.digest('hex');
};

/** Per-file durations in ms — Bun's `--timings` format: `{ "path": ms }`. */
export type Timings = Readonly<Record<string, number>>;

/**
 * Which files shard `index` of `total` runs. Round-robin over the sorted list by default — every
 * shard gets a slice of every directory. With `timings`, greedy longest-first: each file, slowest
 * first (ties by path), goes to the shard with the least total so far (ties to the lowest index);
 * a file the timings do not know is costed at their median, so a new file cannot pile onto one job.
 */
export function shardFiles(
  files: readonly string[],
  spec: ShardSpec,
  timings?: Timings,
): ShardFacts {
  const sorted = [...new Set(files)].sort();
  const hash = corpusHash(sorted);
  let picked: string[];
  if (timings === undefined) {
    picked = sorted.filter((_, position) => position % spec.total === spec.index - 1);
  } else {
    const known = sorted
      .map((file) => timings[file])
      .filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0)
      .sort((a, b) => a - b);
    const median = known.length === 0 ? 1 : (known[Math.floor(known.length / 2)] as number);
    const cost = (file: string): number => {
      const ms = Object.hasOwn(timings, file) ? timings[file] : undefined;
      return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : median;
    };
    const order = [...sorted].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0));
    const loads = Array.from({ length: spec.total }, () => 0);
    const owner = new Map<string, number>();
    for (const file of order) {
      let best = 0;
      for (let shard = 1; shard < spec.total; shard += 1) {
        if ((loads[shard] as number) < (loads[best] as number)) best = shard;
      }
      loads[best] = (loads[best] as number) + cost(file);
      owner.set(file, best);
    }
    picked = sorted.filter((file) => owner.get(file) === spec.index - 1);
  }
  return { index: spec.index, total: spec.total, corpusHash: hash, files: picked };
}

/** A timings file, or a refusal naming it — a CI job must not silently fall back to round-robin. */
export async function readTimings(path: string): Promise<Timings> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new VerifyShardInvalidError({
      reason: `--timings ${path} does not exist`,
      fix: 'bun test --timings=timings.json --update-timings   # writes it, then commit or cache it',
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new VerifyShardInvalidError({
      reason: `--timings ${path} is not a JSON object of { "path": ms }`,
      fix: 'bun test --timings=timings.json --update-timings',
    });
  }
  return parsed as Timings;
}
