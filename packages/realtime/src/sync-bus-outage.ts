// Single responsibility: what a `sync` node says while its bus is away. Without the bus the node
// cannot do its job — that is an ERROR — but it is ONE fact however many sockets beat into it and
// however many sweeps fail: said on failures 1, 2, 4, 8, … and once more when the bus answers.
// Until 2026-10-10 it was `presence.sweep failed` every sweep and one monitor event per refused beat.

import { outageLog, renderThrowable, reportError } from '@ultimat3/core';
import { reportDetached } from './detach';
import type { PresenceRegistry } from './presence';

/** The line a node writes while its bus is away; `<event> recovered` when it is back. */
export const SYNC_BUS_UNAVAILABLE = 'sync.bus_unavailable';

export interface BusOutage {
  /**
   * `true` when `error` is the bus being away — counted, and logged + reported only on the
   * outage's milestones. `false` for anything else, which stays the caller's to report.
   */
  refused(error: unknown, operation: string, at?: string): boolean;
  /** The bus answered: the outage, if there was one, is over. */
  answered(): void;
  /** `detach` for work that reaches the bus: an outage is thinned, any other failure is not. */
  detach(work: Promise<unknown>, operation: string, at?: string): void;
  /** One presence sweep. A pass that read at least one room is the bus answering. */
  sweep(presence: PresenceRegistry): void;
}

const codeOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? (error as { readonly code?: unknown }).code : null;

export function busOutage(): BusOutage {
  const log = outageLog({ event: SYNC_BUS_UNAVAILABLE, level: 'error' });
  const refused = (error: unknown, operation: string, at?: string): boolean => {
    if (codeOf(error) !== 'X_TRANSPORT_UNAVAILABLE') return false;
    const said = log.failed({
      operation,
      ...(at === undefined ? {} : { at }),
      error: renderThrowable(error),
    });
    // The monitor is thinned with the log: one outage is not one event per socket per beat.
    if (said) reportError(error, { source: 'realtime', scope: { operation } });
    return true;
  };
  const detached = (work: Promise<unknown>, operation: string, at?: string): void => {
    void work.catch((error: unknown) => {
      if (!refused(error, operation, at)) reportDetached(error, operation, at);
    });
  };
  return {
    refused,
    answered: () => log.recovered(),
    detach: detached,
    sweep(presence) {
      const rooms = presence.rooms;
      detached(
        presence.sweepAll().then(() => {
          if (rooms > 0) log.recovered();
        }),
        'presence.sweep',
      );
    },
  };
}
