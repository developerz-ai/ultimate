/** Errors the runs feature can raise. No `docs:` — `UltimateError` resolves it from the code. */

import { defineError } from '@ultimat3/core';

export const ConnectionNotFound = defineError<string>({
  code: 'X_CONNECTION_NOT_FOUND',
  title: 'no such connection in the acting org',
  status: 404,
  cause: (connectionId) =>
    `connection ${JSON.stringify(connectionId)} does not exist in the acting org`,
  fix: 'x queries show runConnections --json, then pass an id that read returns',
});

/** 503: the request was fine, this process cannot serve it — a retry on another one may land. */
export const RunQueueUnavailable = defineError<string>({
  code: 'X_RUN_QUEUE_UNAVAILABLE',
  title: 'this process has no job queue to start a run on',
  status: 503,
  cause: (what) => `${what} needs the job queue, and this process installed no job driver`,
  fix: 'x dev',
});

export const RunNotFound = defineError<string>({
  code: 'X_RUN_NOT_FOUND',
  title: 'no such run in the acting org',
  status: 404,
  cause: (runId) => `run ${JSON.stringify(runId)} does not exist in the acting org`,
  fix: 'x queries show liveRunEvents --json, then pass the runId startRun answered',
});
