// `job.concurrency` as DECLARED, resolved once: a plain number is one cap for the whole job, and
// `{ key, limit, whenBusy }` is that cap per key — "at most N runs of this job for this account,
// fleet-wide". Apart from `job.ts` because that file is the primitive and its registry; this one
// is the single reader of the two spellings, so the worker and the projections never branch on
// which one an author wrote.

import type { ConcurrencyKeyDefect } from './errors-concurrency';
import { JobConcurrencyInvalidError, JobConcurrencyKeyInvalidError } from './errors-concurrency';

/** What a claim does when its key already holds `limit` runs. Closed: there is no third answer. */
export const WHEN_BUSY = ['wait', 'fail'] as const;

export type WhenBusy = (typeof WHEN_BUSY)[number];

export interface KeyedConcurrency<I> {
  /**
   * The lease this input's run counts under. Deterministic from `input` only — it is asked once
   * at enqueue and again at every claim, and two answers for one input are two locks.
   */
  readonly key: (input: I) => string;
  /** Max in-flight runs sharing one key, across the fleet. A whole number, 1 or more. */
  readonly limit: number;
  /**
   * `'wait'` (default): the run stays queued and is claimed again once a slot frees.
   * `'fail'`: the run settles `failed` with `X_JOB_KEY_BUSY`, its body never runs, nothing retries it.
   *
   * There is no `duration`: the bound after which a stuck holder stops blocking its key is the
   * lease TTL the heartbeat renews (`leases.ts`), and a second number that could disagree with it
   * would be a second way to say one thing.
   */
  readonly whenBusy?: WhenBusy;
}

export type JobConcurrency<I> = number | KeyedConcurrency<I>;

/**
 * A lease row is keyed by this text and `x_job_leases` indexes it, so a key is an id, never a
 * payload. Far under what a btree entry holds, and far over any account or connection id.
 */
export const MAX_CONCURRENCY_KEY_LENGTH = 200;

export interface ResolvedConcurrency<I> {
  /** The cap — per key when `whenBusy` is set, for the whole job when it is not. */
  readonly limit: number | undefined;
  /** Set exactly when the cap is KEYED, so it doubles as that question's answer. */
  readonly whenBusy: WhenBusy | undefined;
  /**
   * The key this input counts under, or `undefined` when the cap is not keyed. `name` is the
   * job's CURRENT name — registration renames a handle in place, after this was resolved.
   */
  keyFor(name: string, input: I): string | undefined;
}

const unkeyed = (): undefined => undefined;

/** A cap some worker can fill: whole, and at least one. Refuses `NaN`, `Infinity` and `1.5` too. */
const fillable = (limit: unknown): limit is number =>
  typeof limit === 'number' && Number.isInteger(limit) && limit >= 1;

const isWhenBusy = (value: unknown): value is WhenBusy =>
  (WHEN_BUSY as readonly unknown[]).includes(value);

/**
 * Refuses a declaration no worker can honour, where it is written. A `limit` of zero is a slot
 * table that grants nothing — `leases.acquire(key, 0, …)` answers `undefined` forever with no log
 * line — and `NaN` / `Infinity` / `1.5` are the same defect spelled three other ways.
 */
export function resolveConcurrency<I>(
  job: string,
  declared: JobConcurrency<I> | undefined,
): ResolvedConcurrency<I> {
  if (declared === undefined) return { limit: undefined, whenBusy: undefined, keyFor: unkeyed };
  if (typeof declared === 'number') {
    // ONE refusal for both spellings: the plain number used to raise `X_INVARIANT`, which was a
    // second code for the statement `concurrency.limit` makes below.
    if (!fillable(declared)) {
      throw new JobConcurrencyInvalidError({
        job,
        field: 'concurrency',
        declared,
        why: 'which no worker can ever fill',
        edit: 'set a whole concurrency of 1 or more, or omit the field for no cap at all,',
      });
    }
    return { limit: declared, whenBusy: undefined, keyFor: unkeyed };
  }
  // Read off the VALUE: generated code and JS callers reach here with what the type forbids.
  const loose: unknown = declared;
  if (typeof loose !== 'object' || loose === null) {
    throw new JobConcurrencyInvalidError({
      job,
      field: 'concurrency',
      declared: loose,
      why: 'which is neither a whole number nor { key, limit }',
      edit: 'set concurrency: { key: (input) => input.accountId, limit: 1 }',
    });
  }
  const { key, limit, whenBusy } = declared;
  if (typeof key !== 'function') {
    throw new JobConcurrencyInvalidError({
      job,
      field: 'concurrency.key',
      declared: key,
      why: 'which is not a function of the input',
      edit: 'set concurrency.key: (input) => input.accountId',
    });
  }
  if (!fillable(limit)) {
    throw new JobConcurrencyInvalidError({
      job,
      field: 'concurrency.limit',
      declared: limit,
      why: 'which no worker can ever fill',
      edit: 'set a whole concurrency.limit of 1 or more',
    });
  }
  if (whenBusy !== undefined && !isWhenBusy(whenBusy)) {
    throw new JobConcurrencyInvalidError({
      job,
      field: 'concurrency.whenBusy',
      declared: whenBusy,
      why: `and only ${WHEN_BUSY.join(' and ')} exist`,
      edit: "set concurrency.whenBusy to 'wait' (the run stays queued) or 'fail' (the run settles failed with X_JOB_KEY_BUSY)",
    });
  }

  return {
    limit,
    whenBusy: whenBusy ?? 'wait',
    keyFor(name: string, input: I): string {
      const answered: unknown = key(input);
      const refuse = (defect: ConcurrencyKeyDefect): JobConcurrencyKeyInvalidError =>
        new JobConcurrencyKeyInvalidError({
          job: name,
          defect,
          maxLength: MAX_CONCURRENCY_KEY_LENGTH,
        });
      if (typeof answered !== 'string') throw refuse('unreadable');
      if (answered.length === 0) throw refuse('empty');
      if (answered.length > MAX_CONCURRENCY_KEY_LENGTH) throw refuse('too-long');
      return answered;
    },
  };
}
