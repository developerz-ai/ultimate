/** Errors the runs feature can raise. No `docs:` — `UltimateError` resolves it from the code. */

import { UltimateError } from '@ultimat3/core';

export class ConnectionNotFound extends UltimateError {
  constructor(connectionId: string) {
    super({
      code: 'X_CONNECTION_NOT_FOUND',
      cause: `connection ${JSON.stringify(connectionId)} does not exist in the acting org`,
      fix: 'x queries show runConnections --json, then pass an id that read returns',
    });
  }
}

export class RunQueueUnavailable extends UltimateError {
  constructor(what: string) {
    super({
      code: 'X_RUN_QUEUE_UNAVAILABLE',
      cause: `${what} needs the job queue, and this process installed no job driver`,
      fix: 'x dev',
    });
  }
}

export class RunNotFound extends UltimateError {
  constructor(runId: string) {
    super({
      code: 'X_RUN_NOT_FOUND',
      cause: `run ${JSON.stringify(runId)} does not exist in the acting org`,
      fix: 'x queries show liveRunEvents --json, then pass the runId startRun answered',
    });
  }
}
