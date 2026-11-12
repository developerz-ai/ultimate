// `cronJob()`: a job and the task that fires it, from one declaration — a factory over `job()` and
// `task()`, never a ninth primitive (`PRIMITIVE_FACTORIES`). The handle IS the job; `.schedule` is
// the task, named `<job>.schedule`, so the scheduler's `lastFiredAt` and occurrence keys follow the
// job's pinned name. `tz` is required, as on `task()`: an unzoned cron drifts at every DST switch.

import type { StandardSchemaV1 } from '@ultimat3/schema';
import { t } from '@ultimat3/schema';
import { JobDeclarationInvalidError } from './errors-declaration';
import { job } from './job';
import type { JobDefinition, JobHandle } from './job-types';
import type { CatchUpPolicy, TaskHandle } from './task';
import { task } from './task';

/** The input of a cron job that declares none: every occurrence enqueues `{}`. */
export type CronJobNoInput = Readonly<Record<string, never>>;

interface CronJobFields<I, R>
  extends Omit<JobDefinition<I, R>, 'name' | 'input' | 'idempotencyKey'> {
  /**
   * REQUIRED, unlike `job()`'s: the task is `<name>.schedule`, and the scheduler keys a task's
   * `lastFiredAt` and its occurrence lock by name — an export name an import alias can move.
   */
  readonly name: string;
  readonly cron: string;
  /** REQUIRED IANA zone, e.g. `'UTC'`, `'Europe/Berlin'`. */
  readonly tz: string;
  readonly catchUp?: CatchUpPolicy;
  readonly maxCatchUp?: number;
  /**
   * Default `() => name`: one live run at a time, and a manual `.schedule.enqueue()` while one
   * runs is that run. A scheduled occurrence is keyed by its instant on top of this either way.
   */
  readonly idempotencyKey?: (input: I) => string;
}

/** A cron job with no input: each occurrence enqueues `{}`. */
export interface CronJobPlainDefinition<R> extends CronJobFields<CronJobNoInput, R> {
  readonly input?: undefined;
  readonly payload?: undefined;
}

/** A cron job with an input: `payload` builds one occurrence's, from that occurrence's instant. */
export interface CronJobInputDefinition<I, R> extends CronJobFields<I, R> {
  readonly input: StandardSchemaV1<unknown, I>;
  /**
   * The occurrence's instant, never the wall clock: a late or caught-up tick fires for an instant
   * the clock has already passed, and a payload read off `Date.now()` is for the wrong day.
   */
  readonly payload: (occurrenceMs: number) => I;
}

export type CronJobDefinition<I, R> = CronJobPlainDefinition<R> | CronJobInputDefinition<I, R>;

export interface CronJob<I = unknown> extends JobHandle<I> {
  /** The task that fires this job — a `task()` handle like any other. */
  readonly schedule: TaskHandle;
}

const NO_INPUT: StandardSchemaV1<unknown, CronJobNoInput> = t.object({}) as StandardSchemaV1<
  unknown,
  CronJobNoInput
>;

export function cronJob<R = unknown>(
  definition: CronJobPlainDefinition<R>,
): CronJob<CronJobNoInput>;
export function cronJob<I, R = unknown>(definition: CronJobInputDefinition<I, R>): CronJob<I>;
export function cronJob<I, R>(definition: CronJobDefinition<I, R>): CronJob<I> {
  const { cron, tz, catchUp, maxCatchUp, payload, ...rest } = definition;
  const { name } = definition;
  // The type pairs them; a JS caller or a cast can still declare an input no occurrence can fill.
  if (definition.input !== undefined && typeof payload !== 'function') {
    throw new JobDeclarationInvalidError({ job: name, missing: ['payload'] });
  }
  const occurrence = (occurrenceMs: number): I =>
    (typeof payload === 'function' ? payload(occurrenceMs) : {}) as I;
  // The task first: its tz and cron are the likelier refusal, and it names nothing until fired.
  const schedule = task({
    name: `${name}.schedule`,
    cron,
    tz,
    ...(catchUp === undefined ? {} : { catchUp }),
    ...(maxCatchUp === undefined ? {} : { maxCatchUp }),
    enqueue: (occurrenceMs) => [[handle, occurrence(occurrenceMs)]],
  });
  const handle: JobHandle<I> = job<I, R>({
    ...(rest as Omit<JobDefinition<I, R>, 'input' | 'idempotencyKey'>),
    input: (definition.input ?? NO_INPUT) as StandardSchemaV1<unknown, I>,
    idempotencyKey:
      (definition.idempotencyKey as ((input: I) => string) | undefined) ?? (() => name),
  });
  return Object.assign(handle, { schedule });
}
