// What `x deploy verify` reports: its `--json` shape and the finding for each way it fails. Causes
// run every server-named build through `renderCauseValue`, and fixes every value through
// `renderFixShellArg`, because a load balancer writes those strings.

import { ERROR_DOCS_URL, renderCauseValue, renderFixShellArg } from '@ultimat3/core';
import type { VerifyOptions } from './deploy-verify-flags';
import type { QueueGrade, SampleFailure, SampleTally, UnservedQueue } from './deploy-verify-grade';
import { tallyToJson } from './deploy-verify-grade';
import type { Finding, JsonValue } from './output';

/** What the wait ended on. `lastFailure`: the last transport error, when a sample had one. */
export interface WaitOutcome {
  readonly tally: SampleTally;
  readonly closed: boolean;
  readonly lastFailure: string | undefined;
}

export const unservedFinding = (unserved: UnservedQueue, origin: string): Finding => {
  const running =
    unserved.builds.length === 0
      ? 'no worker claims it'
      : `the workers claiming it run ${unserved.builds.map((build) => renderCauseValue(build)).join(', ')}, or are draining`;
  const queue = renderFixShellArg(unserved.queue, '<queue>');
  return {
    code: 'X_DEPLOY_QUEUE_UNSERVED',
    cause: `queue ${renderCauseValue(unserved.queue)} has no serving worker of this build, with ${unserved.depth} job(s) due or running: ${running}`,
    fix: `x jobs list --json   # then WORKER_QUEUES=${queue} on a worker Deployment, or x deploy verify --url ${renderFixShellArg(origin, 'https://app.example.com')} --idle-ok ${queue} --json for a scale-to-zero pool`,
    docs: ERROR_DOCS_URL,
    meta: { queue: unserved.queue, builds: [...unserved.builds], depth: unserved.depth },
  };
};

/** Every queue read failed until `--timeout`: the database was never read, so nothing passed. */
export const queueReadFinding = (lastFailure: string | undefined): Finding => ({
  code: 'X_DB_UNAVAILABLE',
  cause: `no read of x_job_workers succeeded before --timeout passed${lastFailure === undefined ? '' : `: ${renderCauseValue(lastFailure)}`}`,
  fix: 'x jobs list --json   # the same rows, over the same DATABASE_URL',
  docs: ERROR_DOCS_URL,
  ...(lastFailure === undefined ? {} : { meta: { lastFailure } }),
});

export function sampleFinding(
  failure: SampleFailure,
  wait: WaitOutcome,
  build: string,
  options: VerifyOptions,
): Finding {
  const samples = tallyToJson(wait.tally);
  const url = renderFixShellArg(options.origin, 'https://app.example.com');
  const rerun = `x deploy verify --url ${url} --build ${renderFixShellArg(build, '"$BUILD_ID"')} --json`;
  const name = renderCauseValue(build);
  const texts: Readonly<Record<SampleFailure, { readonly cause: string; readonly fix: string }>> = {
    X_DEPLOY_BUILD_MISMATCH: {
      cause: `no sample of ${samples.total} carried build ${name} before --timeout passed`,
      fix: `x deploy verify --url ${url} --build "$BUILD_ID" --json   # the id CI stamped; meta.byBuild names what answered`,
    },
    X_DEPLOY_BUILD_UNSTAMPED: {
      cause: `${wait.tally.unstamped} of ${samples.total} samples answered 2xx with no x-ultimate-build, so the image names no build`,
      fix: 'x build --target docker --json   # stamps BUILD_ID into the image; or set BUILD_ID in the image environment',
    },
    X_DEPLOY_UNSTABLE: {
      cause: `build ${name} answered, but ${options.windowMs} ms of consecutive good samples never closed: ${samples.good} of ${samples.total} were good`,
      fix: `${rerun}   # samples.byStatus and samples.byBuild name what interrupted it`,
    },
  };
  return {
    code: failure,
    ...texts[failure],
    docs: ERROR_DOCS_URL,
    meta: {
      build,
      byBuild: samples.byBuild,
      byStatus: samples.byStatus,
      ...(wait.lastFailure === undefined ? {} : { lastFailure: wait.lastFailure }),
    },
  };
}

export const resultData = (
  build: string,
  windowMs: number,
  tally: SampleTally,
  queues: QueueGrade,
): { readonly [key: string]: JsonValue } => ({
  build,
  samples: tallyToJson(tally),
  windowMs,
  queues: {
    graded: queues.graded,
    served: [...queues.served],
    unserved: queues.unserved.map(({ queue, builds, depth }) => ({
      queue,
      builds: [...builds],
      depth,
    })),
    idle: [...queues.idle],
  },
});
