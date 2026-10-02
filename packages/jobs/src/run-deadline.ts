// The run's deadline: CANCEL, then fail the attempt — never the reverse. Apart from `execute.ts`
// at that file's size ceiling; it is the one timer an attempt owns.

import { isUltimateError, logger, renderThrowable } from '@ultimat3/core';
import { JobTimeoutError } from './errors';

/**
 * The run's deadline. It CANCELS before it rejects, and the order is the whole point: the caller
 * nacks on this rejection and the queue hands the job straight to another worker, so the body has
 * to have been told to stop before that becomes possible.
 *
 * Nothing in JS can kill a body that ignores the signal, so what is left is to say so: a run that
 * settles after its deadline logs `jobs.timeout.abandoned`, which is how an app finds the handler
 * that never reads `ctx.signal`. A body that stopped BECAUSE it was cancelled is the intended end
 * and stays quiet.
 */
export function raceTimeout(
  work: Promise<unknown>,
  timeoutMs: number,
  job: string,
  cancel: AbortController,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      const failure = new JobTimeoutError({ job, timeoutMs });
      cancel.abort(failure);
      reject(failure);
    }, timeoutMs);
    const abandoned = (ended: 'resolved' | 'rejected', error?: unknown): void => {
      logger.warn('jobs.timeout.abandoned', {
        job,
        timeoutMs,
        ended,
        ...(error === undefined ? {} : { error: renderThrowable(error) }),
      });
    };
    work.then(
      (value) => {
        clearTimeout(timer);
        if (expired) abandoned('resolved');
        else resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        if (!expired) reject(error);
        else if (!isCancellation(error, cancel.signal.reason)) abandoned('rejected', error);
      },
    );
  });
}

/** The body stopped because we cancelled it: our own reason back, or a fenced step write. */
function isCancellation(error: unknown, reason: unknown): boolean {
  return error === reason || (isUltimateError(error) && error.code === 'X_ABORTED');
}
