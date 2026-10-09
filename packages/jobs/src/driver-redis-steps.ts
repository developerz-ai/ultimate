// The Redis driver's `StepStore`: one HASH per run (`steps:<runId>`), step name → the record as
// JSON. Through JSON exactly as the pg store persists it, so a step replays a `Date` as the same
// string under every driver. A write made under a claim is fenced in one script on the row that
// claim must still hold (`SQL_STEP_PUT`'s fence) and is `X_JOB_LEASE_LOST` otherwise.

import type { RedisSender } from './driver-redis';
import { REDIS_STEP_PUT_FENCED } from './driver-redis-scripts';
import { LeaseLostError } from './errors';
import type { StepRecord, StepStore } from './steps';
import { isStepStatus } from './steps';

interface StepStoreSeams {
  /** The namespace, `{<prefix>}`. */
  readonly ns: string;
  /** One script, routed to the namespace's slot. */
  readonly run: (script: string, args: readonly (string | number)[]) => Promise<unknown>;
  readonly client: RedisSender;
}

/** A stored step, or nothing — a value that is not one of ours is never cast onto a record. */
function parseStep(text: unknown): StepRecord | undefined {
  if (typeof text !== 'string') return undefined;
  const record = JSON.parse(text) as StepRecord;
  return isStepStatus(record.status) ? record : undefined;
}

export function redisStepStore({ ns, run, client }: StepStoreSeams): StepStore {
  const key = (runId: string) => `${ns}:steps:${runId}`;
  return {
    async get(runId, name) {
      return parseStep(await client.send('HGET', [key(runId), name]));
    },
    async put(record, by) {
      const text = JSON.stringify({ ...record, output: record.output ?? null });
      if (by === undefined) {
        await client.send('HSET', [key(record.runId), record.name, text]);
        return;
      }
      const landed = await run(REDIS_STEP_PUT_FENCED, [
        by.jobId,
        by.workerId,
        by.claim,
        record.runId,
        record.name,
        text,
      ]);
      if (Number(landed) !== 1) throw new LeaseLostError({ job: by.job, jobId: by.jobId });
    },
    async list(runId) {
      const values = await client.send('HVALS', [key(runId)]);
      const records = (Array.isArray(values) ? values : []).flatMap((text: unknown) => {
        const record = parseStep(text);
        return record === undefined ? [] : [record];
      });
      return records.sort((a, b) => a.startedAt - b.startedAt);
    },
    async del(runId, name) {
      await client.send('HDEL', [key(runId), name]);
    },
    async clear(runId) {
      await client.send('DEL', [key(runId)]);
    },
  };
}
