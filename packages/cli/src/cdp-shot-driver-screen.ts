// The DNS half of a shot session's request interception. `cdp-shot-watch.ts` decides every paused
// request by NAME (core's `hostDecision`, whose floor already refuses a private address literal and
// a `localhost` name); a name that RESOLVES inward needs a resolver, which is asynchronous. So the
// watch is handed a connection whose `Fetch.requestPaused` events are screened first: a refused
// request is failed here and never reaches the watch, an admitted one is handed on unchanged.
// Chrome re-resolves the name itself (rebinding stays open, as `@ultimat3/scraping`'s browser leg
// documents): this closes the static case, not the race. A WebSocket handshake is never paused by
// `Fetch` at all — whoever screens a session refuses sockets in the page (`DESIGN_PREPARE`).

import type { CdpConnection, CdpEventListener } from '@ultimat3/scraping/cdp';

/** Why a request was refused: it resolves inward, or it could not be resolved at all. */
export type DialRefusal = 'private' | 'unresolved';

export interface DialScreen {
  /** The sessions whose pauses are this session's to decide; another's pass through untouched. */
  readonly owns: (sessionId: string | undefined) => boolean;
  /**
   * `undefined` when there is nothing to resolve (the watch decides alone), else a promise of the
   * refusal — `undefined` when the request may go. A rejection refuses as `unresolved`: an
   * unscreened request is never released, and a resolver that failed proved nothing private.
   */
  readonly screen: (url: string) => Promise<DialRefusal | undefined> | undefined;
  /** Told of each refusal and why, so the caller can report what the page tried to reach. */
  readonly refused: (url: string, reason: DialRefusal) => void;
}

const urlOf = (params: Record<string, unknown>): string => {
  const request = params['request'];
  if (typeof request !== 'object' || request === null) return '';
  const url = (request as Record<string, unknown>)['url'];
  return typeof url === 'string' ? url : '';
};

export function screenedConnection(connection: CdpConnection, dial: DialScreen): CdpConnection {
  const screenedListener =
    (listener: CdpEventListener): CdpEventListener =>
    (params, on) => {
      if (!dial.owns(on)) return listener(params, on);
      const url = urlOf(params);
      const pending = dial.screen(url);
      if (pending === undefined) return listener(params, on);
      void pending
        .catch((): DialRefusal => 'unresolved')
        .then((refusal) => {
          if (refusal === undefined) return listener(params, on);
          dial.refused(url, refusal);
          return connection
            .send(
              'Fetch.failRequest',
              { requestId: params['requestId'], errorReason: 'BlockedByClient' },
              on,
            )
            .then(
              () => undefined,
              () => undefined,
            );
        });
    };
  return {
    send: (method, params, sessionId, deadlineMs) =>
      connection.send(method, params, sessionId, deadlineMs),
    once: (method, sessionId, timeoutMs) => connection.once(method, sessionId, timeoutMs),
    on: (method, listener) =>
      connection.on(
        method,
        method === 'Fetch.requestPaused' ? screenedListener(listener) : listener,
      ),
    close: () => connection.close(),
  };
}
