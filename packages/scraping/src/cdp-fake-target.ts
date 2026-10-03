// The browser TARGET of `cdp-fake.ts`'s browser: one raw session that records what the driver
// enabled and answers `Fetch.requestPaused` the way Chrome does — a request from a target this
// package never created (a popup) pauses here and nowhere else. Split out because `cdp-fake.ts`
// stands near its size ceiling.

import type { CdpBrowserSessionLike, CdpBrowserTargetLike } from './cdp-port';

export interface FakeBrowserTarget {
  readonly target: CdpBrowserTargetLike;
  /** A request from another target — a popup — pausing at the browser-level `Fetch` domain. */
  emitTargetRequest(url: string, resourceType: string, method?: string): void;
  /** What browser-level interception decided, and whether it was enabled at all. */
  readonly browserFetch: {
    readonly enabled: boolean;
    readonly continued: readonly string[];
    readonly failed: readonly string[];
  };
}

/** `refuseEnable`: the browser answers `Fetch.enable` with a protocol error, as a locked-down provider might. */
export function fakeBrowserTarget(
  options: { readonly refuseEnable?: boolean } = {},
): FakeBrowserTarget {
  const listeners: ((payload: unknown) => void)[] = [];
  const byId = new Map<string, string>();
  const continued: string[] = [];
  const failed: string[] = [];
  let enabled = false;
  const session: CdpBrowserSessionLike = {
    send: (method, params) => {
      if (method === 'Fetch.enable') {
        if (options.refuseEnable === true) {
          return Promise.reject(new Error("'Fetch.enable' wasn't found"));
        }
        enabled = true;
      }
      const id = typeof params?.['requestId'] === 'string' ? params['requestId'] : '';
      if (method === 'Fetch.continueRequest') continued.push(byId.get(id) ?? id);
      if (method === 'Fetch.failRequest') failed.push(byId.get(id) ?? id);
      return Promise.resolve({});
    },
    detach: () => Promise.resolve(),
    on: (event, handler) => {
      if (event === 'Fetch.requestPaused') listeners.push(handler);
      return undefined;
    },
  };
  return {
    target: { createCDPSession: () => Promise.resolve(session) },
    emitTargetRequest(url, resourceType, method = 'GET'): void {
      // Paused only while enabled, as in Chrome: before `Fetch.enable` the request just leaves.
      if (!enabled) return;
      const requestId = `interception-${String(byId.size + 1)}`;
      byId.set(requestId, url);
      for (const listener of listeners) {
        listener({ requestId, resourceType, request: { url, method } });
      }
    },
    browserFetch: {
      get enabled(): boolean {
        return enabled;
      },
      continued,
      failed,
    },
  };
}
