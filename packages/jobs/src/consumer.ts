// `consumer()` — reading a queue, a stream or a vendor's cursor as a `job` plus a `.supervisor`
// `task`: a factory over `job()`, never a ninth primitive. It assembles what a hand-rolled one must
// remember and has no build error for — one body per key, a key per key, no timeout, a supervisor,
// the drain, a cursor committed with its batch. The turn itself is `consumer-loop.ts`.

import { t } from '@ultimat3/schema';
import { finiteDurationMs } from './clock';
import { ConsumerInvalidError } from './consumer-errors';
import { asConsumer, refuseSelfEnqueue } from './consumer-guard';
import { consumerRun, DEFAULT_CONSUMER_BATCH } from './consumer-loop';
import { stampConsumer } from './consumer-registry';
import type { ConsumerDefinition, ConsumerHandle, ConsumerInput } from './consumer-types';
import type { EnqueueResult } from './driver';
import type { JobHandle } from './job';
import { job } from './job';
import type { EnqueueManyOptions } from './job-enqueue-many';
import type { EnqueueOptions } from './outbox';
import { DEFAULT_RETRY } from './retry';
import { task } from './task';

const MINUTE_MS = 60_000;

/** `'1m'` → `* * * * *`; whole minutes dividing an hour, so every tick is evenly spaced. */
function rearmCron(name: string, rearm: string | number): string {
  const ms = finiteDurationMs(rearm, `consumer "${name}"`, 'rearm');
  const minutes = ms / MINUTE_MS;
  if (!Number.isInteger(minutes) || minutes < 1 || 60 % minutes !== 0) {
    throw new ConsumerInvalidError({
      consumer: name,
      problem: `declares rearm ${String(rearm)}, and the supervisor's cron ticks in whole minutes that divide an hour (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60)`,
      fix: `rearm: '1m' on consumer({ name: "${name}" })`,
    });
  }
  if (minutes === 60) return '0 * * * *';
  return minutes === 1 ? '* * * * *' : `*/${minutes} * * * *`;
}

/** Every refusal a declaration can earn, before anything is registered under its name. */
function assertDeclaration<Item, C>(definition: ConsumerDefinition<Item, C>): number {
  const name = definition.name;
  const cursor: unknown = definition.cursor;
  const seam = (cursor ?? {}) as { readonly load?: unknown; readonly save?: unknown };
  if (typeof seam.load !== 'function' || typeof seam.save !== 'function') {
    throw new ConsumerInvalidError({
      consumer: name,
      problem:
        'declares no cursor.load and cursor.save, so a restart would re-read its stream from the top and no batch could commit its position',
      fix: `cursor: { load: (key) => repo.cursorOf(key), save: (key, next) => repo.saveCursor(key, next) } on consumer({ name: "${name}" })`,
    });
  }
  if ((definition as { readonly timeout?: unknown }).timeout !== undefined) {
    throw new ConsumerInvalidError({
      consumer: name,
      problem:
        'declares a timeout, which kills a long-lived stream mid-batch on a schedule nobody chose; a run ends when its stream does, or when a drain stops it',
      fix: `consumer({ name: "${name}", ...definition }) with the timeout field deleted`,
    });
  }
  for (const field of ['keys', 'open', 'handle'] as const) {
    if (typeof definition[field] !== 'function') {
      throw new ConsumerInvalidError({
        consumer: name,
        problem: `declares no ${field}()`,
        fix: `${field}: (args) => … on consumer({ name: "${name}" })`,
      });
    }
  }
  const size = definition.batch ?? DEFAULT_CONSUMER_BATCH;
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new ConsumerInvalidError({
      consumer: name,
      problem: `declares batch ${String(size)}, and a batch is a whole number of items, at least one`,
      fix: `consumer({ name: "${name}", batch: ${DEFAULT_CONSUMER_BATCH} })`,
    });
  }
  return size;
}

export function consumer<Item, C>(definition: ConsumerDefinition<Item, C>): ConsumerHandle {
  const size = assertDeclaration(definition);
  const name = definition.name;
  const cron = rearmCron(name, definition.rearm ?? '1m');
  const queue = definition.queue === undefined ? {} : { queue: definition.queue };

  const handle: JobHandle<ConsumerInput> = job<ConsumerInput>({
    name,
    input: t.object({ key: t.string.min(1) }),
    tenant: definition.tenant,
    // A key is live while its row is queued or running, so a re-arm of a running key is deduped:
    // the supervisor is a no-op while a run is live and a restart once it is not.
    idempotencyKey: ({ key }) => `consumer:${name}:${key}`,
    // The backstop the key alone cannot be: two rows of one key never run at once.
    concurrency: { key: ({ key }) => key, limit: 1, whenBusy: 'wait' },
    retry: definition.retry ?? DEFAULT_RETRY,
    ...queue,
    run: (args) => asConsumer(name, () => consumerRun({ definition, size }, args)),
  });

  // The un-guarded enqueues, kept for the arm run below: it is a different job, and the only
  // thing in the framework that enqueues a consumer.
  const enqueue = handle.enqueue.bind(handle);
  const enqueueMany = handle.enqueueMany.bind(handle);
  // Guarded IN PLACE, never a wrapper object: only the object `job()` built passes `isJobHandle`.
  Object.assign(handle, {
    async enqueue(input: ConsumerInput, options?: EnqueueOptions): Promise<EnqueueResult> {
      refuseSelfEnqueue(handle.name);
      return enqueue(input, options);
    },
    async enqueueMany(inputs: readonly ConsumerInput[], options?: EnqueueManyOptions) {
      refuseSelfEnqueue(handle.name);
      return enqueueMany(inputs, options);
    },
  });

  // `keys` may read the database, and a task's entries are synchronous — so the tick enqueues
  // this one arm run, which asks `keys` and enqueues every key it answers.
  const arm = job<Record<string, never>>({
    name: `${name}.arm`,
    input: t.object({}),
    tenant: 'none',
    idempotencyKey: () => `consumer:${name}:arm`,
    retry: DEFAULT_RETRY,
    ...queue,
    async run({ ctx, step }) {
      const keys = await definition.keys({ ctx });
      // A step: an arm killed after its enqueue and before its ack replays the result rather than
      // enqueuing the keys again behind a consumer that already finished.
      const results = await step.run('start-keys', () => enqueueMany(keys.map((key) => ({ key }))));
      return { keys: keys.length, started: results.filter((result) => !result.deduped).length };
    },
  });
  const supervisor = task({
    name: `${name}.supervisor`,
    cron,
    tz: 'UTC',
    enqueue: () => [[arm, {}]],
  });

  stampConsumer(handle, {
    supervisor: supervisor.name,
    arm: arm.name,
    cron,
    batch: size,
    lags: definition.lag !== undefined,
  });
  return Object.assign(handle, { supervisor });
}
