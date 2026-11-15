// The browser TARGET of `cdp-fake-fixture.ts`'s browser: one raw session that records what the
// driver enabled and answers `Fetch.requestPaused` and a download's two halves the way Chrome does.
//
// A request from a target this package never created (a popup) pauses here and nowhere else; a
// download is the Response-stage pause carrying the body, then `Browser.downloadWillBegin`. Split
// out because `cdp-fake-fixture.ts` stands near its size ceiling.

import type { CdpBrowserSessionLike, CdpBrowserTargetLike } from './cdp-port';

/** One file a click would make Chrome download, as the wire carries it. */
export interface FakeDownload {
  readonly url: string;
  readonly filename: string;
  readonly body: string;
  readonly contentType?: string;
  /** `Content-Disposition`; absent is a `<a download>` link, which sends none. */
  readonly disposition?: string;
  /** `Content-Length`: the body's own length when absent, `'none'` for a chunked response. */
  readonly length?: number | 'none';
}

export interface FakeBrowserTarget {
  readonly target: CdpBrowserTargetLike;
  /** A request from another target — a popup — pausing at the browser-level `Fetch` domain. */
  emitTargetRequest(url: string, resourceType: string, method?: string): void;
  /**
   * A navigation Chrome turns into a download: the Response-stage pause (only while the driver
   * asked for that stage), and once the driver releases it, `Browser.downloadWillBegin` (only
   * while `Browser.setDownloadBehavior` enabled events). Resolves when both have been delivered.
   */
  emitDownload(download: FakeDownload): Promise<void>;
  /** What browser-level interception decided, and whether it was enabled at all. */
  readonly browserFetch: {
    readonly enabled: boolean;
    readonly continued: readonly string[];
    readonly failed: readonly string[];
    /** Whether the driver asked for Document responses too — the stage a download's body is in. */
    readonly responseStage: boolean;
    /** What `Browser.setDownloadBehavior` was last sent, or `undefined`. */
    readonly downloadBehavior: Readonly<Record<string, unknown>> | undefined;
    /** URLs whose response the driver fulfilled with a body it read. */
    readonly fulfilled: readonly string[];
    /** Body bytes the driver pulled through `IO.read`, all streams together. */
    readonly bytesRead: number;
  };
}

const flushed = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

/** `refuseEnable`: the browser answers `Fetch.enable` with a protocol error, as a locked-down provider might. */
export function fakeBrowserTarget(
  options: { readonly refuseEnable?: boolean } = {},
): FakeBrowserTarget {
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  const byId = new Map<string, string>();
  const bodies = new Map<string, string>();
  const released = new Map<string, (begun: boolean) => void>();
  const streams = new Map<string, { body: string; at: number }>();
  const fulfilled: string[] = [];
  let bytesRead = 0;
  const continued: string[] = [];
  const failed: string[] = [];
  let enabled = false;
  let responseStage = false;
  let downloadBehavior: Readonly<Record<string, unknown>> | undefined;
  const emit = (event: string, payload: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  };
  const session: CdpBrowserSessionLike = {
    send: (method, params) => {
      if (method === 'Fetch.enable') {
        if (options.refuseEnable === true) {
          return Promise.reject(new Error("'Fetch.enable' wasn't found"));
        }
        enabled = true;
        const patterns = Array.isArray(params?.['patterns']) ? params['patterns'] : [];
        responseStage = patterns.some(
          (pattern) => (pattern as { requestStage?: unknown }).requestStage === 'Response',
        );
      }
      if (method === 'Browser.setDownloadBehavior') downloadBehavior = { ...params };
      const id = typeof params?.['requestId'] === 'string' ? params['requestId'] : '';
      if (method === 'Fetch.takeResponseBodyAsStream') {
        const body = bodies.get(id);
        if (body === undefined) return Promise.reject(new Error('No data found for resource'));
        streams.set(`stream-${id}`, { body, at: 0 });
        return Promise.resolve({ stream: `stream-${id}` });
      }
      if (method === 'IO.read') {
        const handle = typeof params?.['handle'] === 'string' ? params['handle'] : '';
        const size = typeof params?.['size'] === 'number' ? params['size'] : 1024;
        const stream = streams.get(handle);
        if (stream === undefined) return Promise.reject(new Error('Invalid stream handle'));
        const data = stream.body.slice(stream.at, stream.at + size);
        stream.at += data.length;
        bytesRead += data.length;
        return Promise.resolve({
          data: btoa(data),
          base64Encoded: true,
          eof: stream.at >= stream.body.length,
        });
      }
      if (method === 'IO.close') {
        streams.delete(typeof params?.['handle'] === 'string' ? params['handle'] : '');
      }
      if (method === 'Fetch.continueRequest' || method === 'Fetch.fulfillRequest') {
        (method === 'Fetch.continueRequest' ? continued : fulfilled).push(byId.get(id) ?? id);
        released.get(id)?.(true);
      }
      if (method === 'Fetch.failRequest') {
        failed.push(byId.get(id) ?? id);
        released.get(id)?.(false);
      }
      return Promise.resolve({});
    },
    detach: () => Promise.resolve(),
    on: (event, handler) => {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
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
      emit('Fetch.requestPaused', { requestId, resourceType, request: { url, method } });
    },
    async emitDownload(download): Promise<void> {
      const begin = (): void => {
        if (downloadBehavior?.['eventsEnabled'] !== true) return;
        emit('Browser.downloadWillBegin', {
          guid: `guid-${download.filename}`,
          url: download.url,
          suggestedFilename: download.filename,
        });
      };
      if (!(enabled && responseStage) || download.url.startsWith('blob:')) {
        begin();
        return;
      }
      const requestId = `interception-${String(byId.size + 1)}`;
      byId.set(requestId, download.url);
      bodies.set(requestId, download.body);
      // A released response becomes a download; a FAILED one never reaches the download manager.
      const done = new Promise<void>((resolve) => {
        released.set(requestId, (begun) => {
          if (begun) begin();
          resolve();
        });
      });
      emit('Fetch.requestPaused', {
        requestId,
        resourceType: 'Document',
        request: { url: download.url, method: 'GET' },
        responseStatusCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: download.contentType ?? 'application/octet-stream' },
          ...(download.disposition === undefined
            ? []
            : [{ name: 'Content-Disposition', value: download.disposition }]),
          ...(download.length === 'none'
            ? []
            : [{ name: 'Content-Length', value: String(download.length ?? download.body.length) }]),
        ],
      });
      await done;
      await flushed();
    },
    browserFetch: {
      get enabled(): boolean {
        return enabled;
      },
      continued,
      failed,
      get responseStage(): boolean {
        return responseStage;
      },
      get downloadBehavior(): Readonly<Record<string, unknown>> | undefined {
        return downloadBehavior;
      },
      fulfilled,
      get bytesRead(): number {
        return bytesRead;
      },
    },
  };
}
