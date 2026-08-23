// Work nobody is waiting on: a presence leave from a synchronous close, a sweep on a timer, a
// fanout off the change bus. Split out of `sync-node.ts` at the 500-line ceiling, and it is the
// natural seam — the function closes over nothing the node holds.

import { logger, renderThrowable, reportError } from '@ultimat3/core';

/**
 * It reaches the bus or a policy, so it can fail; failing must not take a socket or the process
 * with it, and must not be silent either, or "the room still shows someone who left" and "that
 * change reached nobody" have nothing to read. `operation` stays low cardinality so the monitor
 * can group on it; the topic or entity goes in `at`.
 *
 * `renderThrowable` and never `String(error)`: this is the one frame whose whole job is not to
 * throw, and `String()` on a null-prototype throwable raises inside it — the detach's own `catch`,
 * with nothing above it to answer. `channel.ts` already imports it for the same reason.
 */
export function detach(work: Promise<unknown>, operation: string, at?: string): void {
  void work.catch((error: unknown) => {
    logger.error(`${operation} failed`, {
      ...(at === undefined ? {} : { at }),
      error: renderThrowable(error),
    });
    // Nobody is awaiting this, so the log is the only trace it leaves — and a log is not a signal
    // anyone is paged on. The bus is this node's dependency, never the client's.
    reportError(error, { source: 'realtime', scope: { operation } });
  });
}
