// `job({ maxPending })`: refuse a producer while its queue is drowning, before anything is written.
// Asked once per enqueue, on both paths, only for a job that declared the ceiling: one capped count
// (`JobDriver.backlog`), plus what the caller's transaction staged that no count can see yet
// (`backlogLedger`), and never for a call whose keys add no row (`gateBacklog`).

import { assert, renderFixShellArg, UltimateError } from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import type { JobDriver } from './driver';
import type { JobHandle } from './job';

/** An enqueue that would put the queue past the job's declared `maxPending`. A 429. */
export class JobBacklogFullError extends UltimateError {
  constructor(input: { job: string; queue: string; maxPending: number; adding: number }) {
    super({
      code: 'X_JOB_BACKLOG_FULL',
      cause: `job "${input.job}" declares maxPending ${input.maxPending}, and queue "${input.queue}" already holds that many rows waiting to run — ${input.adding} more were refused before any was written`,
      fix: `x jobs list --queue ${renderFixShellArg(input.queue, '<the queue the cause names>')} --json   # the depth; retry this enqueue after a backoff, add workers for "${input.queue}", or raise maxPending on job("${input.job}")`,
      meta: { job: input.job, queue: input.queue, maxPending: input.maxPending },
    });
  }
}

/** The idempotency namespace of one enqueue: what a live holder of it turns into no new row. */
export interface BacklogKey {
  readonly name: string;
  readonly idempotencyKey: string;
  readonly tenantId?: string;
}

/**
 * Refuse `adding` more rows of `job` onto `queue` when they would cross its `maxPending`, counting
 * `staged` rows the caller's own transaction already holds for that queue. A no-op for a job that
 * declared none. Counted before the write and not inside it: the staged path's insert happens
 * after commit, in the relay, where nobody is left to refuse.
 *
 * `key`: a single enqueue's namespace. Asked only once the count says full, so the hot path pays
 * nothing — a LIVE row holding the key means this enqueue inserts nothing (a dedupe, or a replace
 * onto its holder), and an enqueue that adds no row is never refused for the rows it does not add.
 *
 * SOFT across producers: two of them racing the last slot may both pass, and a committed row the
 * relay has not published yet is counted by nobody. The ceiling stops a queue drowning; it is not
 * an exact quota.
 */
export async function refuseBacklog(
  driver: Pick<JobDriver, 'name' | 'backlog' | 'holds'>,
  job: { readonly name: string; readonly maxPending: number | undefined },
  queue: string,
  adding: number,
  extra: { readonly staged?: number; readonly key?: BacklogKey } = {},
): Promise<void> {
  const max = job.maxPending;
  if (max === undefined) return;
  assert(
    driver.backlog !== undefined,
    `job "${job.name}" declares maxPending, and the ${driver.name} job driver counts no backlog (JobDriver.backlog), so the ceiling would hold nothing`,
    `postgresJobDriver()   # or memoryJobDriver() / redisJobDriver() — the drivers that count one — in apps/<app>/runtime.ts, or drop maxPending from job("${job.name}")`,
  );
  const waiting = await driver.backlog(queue, max);
  if (waiting + (extra.staged ?? 0) + adding <= max) return;
  const { key } = extra;
  if (key !== undefined && (await driver.holds?.(key.name, key.idempotencyKey, key.tenantId))) {
    return;
  }
  throw new JobBacklogFullError({ job: job.name, queue, maxPending: max, adding });
}

/** The rows one transaction staged per queue, by key, for the jobs that declare `maxPending`. */
export interface BacklogLedger {
  /** Keys `tx` already staged on `queue` — a set, so a key staged twice is one row. */
  staged(tx: object, queue: string): ReadonlySet<string>;
  /** Record `keys` as staged on `queue` in `tx`. */
  stage(tx: object, queue: string, keys: Iterable<string>): void;
}

/** The ledger's one spelling of a key: JSON, so no separator inside a value merges two. */
export const ledgerKey = (key: BacklogKey): string =>
  JSON.stringify([key.name, key.tenantId ?? '', key.idempotencyKey]);

/** Weakly keyed by the transaction object: a committed or abandoned one takes its entries along. */
export function backlogLedger(): BacklogLedger {
  const byTx = new WeakMap<object, Map<string, Set<string>>>();
  const none: ReadonlySet<string> = new Set();
  return {
    staged: (tx, queue) => byTx.get(tx)?.get(queue) ?? none,
    stage(tx, queue, keys) {
      const queues = byTx.get(tx) ?? new Map<string, Set<string>>();
      byTx.set(tx, queues);
      const held = queues.get(queue) ?? new Set<string>();
      queues.set(queue, held);
      for (const key of keys) held.add(key);
    },
  };
}

/**
 * Refuse the call when the rows it adds would cross `handle.maxPending` (`X_JOB_BACKLOG_FULL`);
 * otherwise record its keys against `tx`, so the next enqueue in the same transaction counts
 * them. Free for a job that declared no ceiling: not a key is derived, and `driver` is never
 * called — the fallback facade's throws when none is installed, which a staged enqueue never needs.
 */
export async function gateBacklog<I>(
  driver: () => Pick<JobDriver, 'name' | 'backlog' | 'holds'>,
  ledger: BacklogLedger,
  handle: JobHandle<I>,
  inputs: readonly I[],
  options: { readonly queue?: string; readonly tenantId?: string },
  tx: Tx | undefined,
): Promise<void> {
  if (handle.maxPending === undefined || inputs.length === 0) return;
  const queue = options.queue ?? handle.queue;
  const staged = tx === undefined ? undefined : ledger.staged(tx, queue);
  const adding = new Map<string, BacklogKey>();
  for (const input of inputs) {
    const tenantId = options.tenantId ?? handle.tenantFor(input);
    const key: BacklogKey = {
      name: handle.name,
      idempotencyKey: handle.idempotencyKeyFor(input),
      ...(tenantId === undefined ? {} : { tenantId }),
    };
    const spelled = ledgerKey(key);
    // Staged already in this transaction: the publish dedupes it onto the first, no new row.
    if (staged?.has(spelled) !== true) adding.set(spelled, key);
  }
  if (adding.size === 0) return;
  // A single enqueue names its key, so a live holder of it can say the call adds no row at all.
  const [only] = adding.values();
  await refuseBacklog(driver(), handle, queue, adding.size, {
    staged: staged?.size ?? 0,
    ...(inputs.length === 1 && only !== undefined ? { key: only } : {}),
  });
  if (tx !== undefined) ledger.stage(tx, queue, adding.keys());
}
