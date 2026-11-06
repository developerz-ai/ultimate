// Single responsibility: what `x repro <id>` is about — a dead job (`x_jobs` and its steps, with or
// without capture), a captured request (`x_failures` by bundle, request or trace id, else the newest
// bundle of a fingerprint), or a bundle file (`--from`). Reads only; refuses with `X_REPRO_*`.

import type { FailureBundle } from '@ultimat3/core';
import { isJsonObject } from '@ultimat3/core';
import { postgresFailureStore } from '@ultimat3/db';
import type { JobDriver } from '@ultimat3/jobs';
import { inspectJob } from '@ultimat3/jobs';
import type { JobFailure } from '@ultimat3/testing';
import { ReproCaptureOffError, ReproUnknownError } from './repro-errors';
import { jobFailureOf } from './repro-job';

export type ReproSubject =
  | { readonly kind: 'job'; readonly failure: JobFailure }
  | { readonly kind: 'request'; readonly bundle: FailureBundle };

/** A uuid in any spelling `x_jobs.id` accepts — `cmd-jobs.ts`' rule, so no statement is wasted. */
const JOB_ID = /^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i;

const isBundle = (value: unknown): value is FailureBundle =>
  isJsonObject(value) &&
  typeof value['name'] === 'string' &&
  (value['primitive'] === 'action' || value['primitive'] === 'query') &&
  Array.isArray(value['reads']);

const isJobFailure = (value: unknown): value is JobFailure =>
  isJsonObject(value) &&
  typeof value['jobId'] === 'string' &&
  typeof value['name'] === 'string' &&
  Array.isArray(value['steps']);

/** `--from <file>`: a bundle `x repro <id> --json` printed (`data.bundle` or `data.failure`), or one bare. */
export async function subjectFromFile(path: string): Promise<ReproSubject> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new ReproUnknownError({ id: path });
  const parsed: unknown = await file.json();
  const data = isJsonObject(parsed) && isJsonObject(parsed['data']) ? parsed['data'] : parsed;
  const inner = isJsonObject(data) ? (data['bundle'] ?? data['failure'] ?? data) : data;
  if (isBundle(inner)) return { kind: 'request', bundle: inner };
  if (isJobFailure(inner)) return { kind: 'job', failure: inner };
  throw new ReproUnknownError({ id: path });
}

/**
 * A job first — its row exists whether or not capture is on — then the captured bundles. Not found
 * anywhere: `X_REPRO_CAPTURE_OFF` when the app never stored bundles, `X_REPRO_UNKNOWN` otherwise.
 */
export async function resolveSubject(
  driver: JobDriver,
  id: string,
  captureOn: boolean,
): Promise<ReproSubject> {
  if (JOB_ID.test(id)) {
    const trace = await inspectJob(driver, id);
    if (trace !== undefined) {
      return { kind: 'job', failure: jobFailureOf(trace, await driver.steps.list(trace.runId)) };
    }
  }
  const store = postgresFailureStore();
  const bundle = (await store.find(id)) ?? (await store.latest(id));
  if (bundle !== undefined) return { kind: 'request', bundle };
  if (!captureOn) throw new ReproCaptureOffError({ id });
  throw new ReproUnknownError({ id });
}
