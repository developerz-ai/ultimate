// What `consumer()` declared, read back off a plain `JobHandle` — the `origin` WeakMap shape
// `backfill-registry.ts` uses, and derived from `registeredJobs()` rather than a second registry.
// Also the one projection of a consumer's run for `x jobs show`: key, last batch at, lag.

import type { JobProgress } from './introspection';
import type { AnyJobHandle } from './job';
import { isJobHandle, registeredJobs } from './job';

/** Everything `consumer()` knows that a `JobHandle` has no field for. */
export interface ConsumerOrigin {
  readonly supervisor: string;
  readonly arm: string;
  readonly cron: string;
  readonly batch: number;
  readonly lags: boolean;
}

/** One declaration as `--json` and the manifest report it. Plain JSON. */
export interface ConsumerDeclaration {
  readonly kind: 'consumer';
  readonly name: string;
  readonly queue: string;
  /** The task that re-arms every key, and the job its tick enqueues. */
  readonly supervisor: string;
  readonly arm: string;
  /** The supervisor's cron, in UTC: a re-arm interval has no wall-clock meaning. */
  readonly rearm: string;
  readonly batch: number;
  /** Whether `lag` was declared, so a reader knows a `lag: null` is "not declared". */
  readonly lags: boolean;
}

/** One consumer run, as `x jobs show <id> --json` reports it under `consumer`. */
export interface ConsumerRow {
  readonly key: string | null;
  /** When the run last reported a committed batch; `null` before its first. */
  readonly lastBatchAt: string | null;
  /** `null` when no `lag` is declared or no batch has committed yet. */
  readonly lag: number | null;
}

const origin = new WeakMap<object, ConsumerOrigin>();

/** Called by `consumer()` and nothing else — not exported from `src/index.ts`. */
export function stampConsumer(handle: AnyJobHandle, source: ConsumerOrigin): void {
  origin.set(handle, source);
}

export function isConsumer(value: unknown): value is AnyJobHandle {
  return isJobHandle(value) && origin.has(value);
}

/** Reads `handle.name` live: registration rebinds that property in place. */
export function consumerDeclarationOf(handle: AnyJobHandle): ConsumerDeclaration | undefined {
  const source = origin.get(handle);
  if (source === undefined) return undefined;
  return {
    kind: 'consumer',
    name: handle.name,
    queue: handle.queue,
    supervisor: source.supervisor,
    arm: source.arm,
    rearm: source.cron,
    batch: source.batch,
    lags: source.lags,
  };
}

/** Every consumer this process declared, in `registeredJobs()`' code-unit order. */
export function registeredConsumers(): readonly ConsumerDeclaration[] {
  const declarations: ConsumerDeclaration[] = [];
  for (const handle of registeredJobs()) {
    const declaration = consumerDeclarationOf(handle);
    if (declaration !== undefined) declarations.push(declaration);
  }
  return declarations;
}

const keyOf = (input: unknown): string | null => {
  if (typeof input !== 'object' || input === null) return null;
  const key = (input as { readonly key?: unknown }).key;
  return typeof key === 'string' ? key : null;
};

/**
 * The consumer row for one run, or `null` when `name` is no declared consumer. The loop reports
 * `progress(items, items + lag)`, so the lag is `total - done` — and only when one is declared.
 */
export function consumerRow(run: {
  readonly name: string;
  readonly input: unknown;
  readonly progress: JobProgress | null;
}): ConsumerRow | null {
  const handle = registeredJobs().find((candidate) => candidate.name === run.name);
  const source = handle === undefined ? undefined : origin.get(handle);
  if (source === undefined) return null;
  const progress = run.progress;
  return {
    key: keyOf(run.input),
    lastBatchAt: progress === null ? null : new Date(progress.at).toISOString(),
    lag: !source.lags || progress === null ? null : progress.total - progress.done,
  };
}
