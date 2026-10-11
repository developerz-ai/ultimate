// Single responsibility: what the `sync` role does when its node cannot start because the bus is
// away. A `ROLE=sync` container refuses its boot — it has nothing to serve without the bus.
// `x dev` runs every role in one process, so there the node stays mounted and NOT ready, and is
// started when the bus answers: the pages, the worker and the scheduler never went down with it.

import { isUltimateError, logger } from '@ultimat3/core';
import type { SyncNode, Transport } from '@ultimat3/realtime/server';

export interface BusWaitRuntime {
  readonly transport: Pick<Transport, 'onReconnect'>;
  /** `RunningServices.busTolerated`: the boot is `x dev`, and a bus that is away is waited for. */
  readonly busTolerated?: boolean | undefined;
}

/**
 * Start the node, or — tolerated, with the bus away — leave it unstarted and start it on the
 * transport's next recovery. Until then an upgrade is shed with a 503 and a retry delay
 * (`sync-upgrade.ts`), so an open page keeps asking and goes live with no restart. Any other
 * refusal, and every refusal outside `x dev`, is the boot's. Returns what stops the wait.
 */
export async function startOrWaitForBus(
  node: Pick<SyncNode, 'start'>,
  runtime: BusWaitRuntime,
): Promise<() => void> {
  const refused = await node.start().then(
    () => undefined,
    (error: unknown) => ({ error }),
  );
  if (refused === undefined) return () => undefined;
  const { error } = refused;
  if (
    runtime.busTolerated !== true ||
    !isUltimateError(error) ||
    error.code !== 'X_TRANSPORT_UNAVAILABLE'
  ) {
    throw error;
  }
  // Once, with the refusal a container would have exited on.
  logger.warn('sync node is waiting for the bus: sockets are refused until it answers', {
    code: error.code,
    cause: error.cause,
    fix: error.fix,
  });
  let waiting = true;
  let off = (): void => undefined;
  const attempt = (): void => {
    if (!waiting) return;
    void node.start().then(
      () => {
        if (!waiting) return;
        waiting = false;
        off();
        logger.info('sync node started: the bus answered');
      },
      // Still away, or away again: the next recovery asks once more.
      () => undefined,
    );
  };
  off = runtime.transport.onReconnect(attempt);
  // The dial may have landed between the refusal and the line above; asking again costs nothing.
  attempt();
  return () => {
    waiting = false;
    off();
  };
}
