// The browser driver's `download()`: the file's bytes taken off the WIRE — the browser-level
// `Fetch` pause at the Response stage — never out of a download directory, which on
// `remoteBrowser()` is somebody else's disk. `Browser.downloadWillBegin` names the file.
//
// Measured on Chrome 157 (2026-11-15): the pause hands over the body before Chrome decides to
// download, and the event follows with the URL and the suggested name.

import type { SleepClock } from '@ultimat3/core';
import type { CdpBrowserSessionLike, CdpPageLike, CdpSessionLike } from './cdp-port';
import { deadline } from './clock';
import { downloadTimeout } from './error-throws';
import type { ScrapeDownloadFile } from './target';

/**
 * How many captured bodies, and how many finished files, are held at once. Bounded because a body
 * is captured BEFORE Chrome says whether it is a download — a run that navigates to a thousand
 * JSON documents must not hold all of them waiting for a `download()` nobody calls.
 */
export const MAX_HELD_DOWNLOADS = 8;

/** How often `next()` looks again, at most, while a download is still on the wire. */
const POLL_MS = 50;

export interface DownloadCatcher {
  /**
   * Asked by `armBrowser` for every RESPONSE-stage pause, before the response is released: once
   * released, the body belongs to the download manager and the protocol has no read for it.
   */
  capture(paused: unknown, session: CdpSessionLike): Promise<void>;
  /** Subscribes to the browser's download events, and turns Chrome's own write to disk off. */
  arm(session: CdpBrowserSessionLike): Promise<void>;
  /** The oldest finished file not yet handed out; `X_SCRAPE_DOWNLOAD_TIMEOUT` past `timeoutMs`. */
  next(timeoutMs: number, url: string): Promise<ScrapeDownloadFile>;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const headerOf = (headers: unknown, name: string): string => {
  if (!Array.isArray(headers)) return '';
  for (const entry of headers) {
    const header = record(entry);
    if (typeof header?.['name'] === 'string' && header['name'].toLowerCase() === name) {
      return typeof header['value'] === 'string' ? header['value'] : '';
    }
  }
  return '';
};

/**
 * Whether a document response could become a download. An attachment always can; so can anything
 * that is not a page — `<a download href="/x.csv">` sends no `Content-Disposition` at all. An HTML
 * page is the one shape skipped, because it is every ordinary navigation of the run and reading
 * its body would cost each one a second copy. A redirect has no body to read.
 */
export function downloadCandidate(status: number, headers: unknown): boolean {
  if (status >= 300 && status < 400) return false;
  if (headerOf(headers, 'content-disposition').toLowerCase().startsWith('attachment')) return true;
  const type = headerOf(headers, 'content-type').toLowerCase();
  return !(type.startsWith('text/html') || type.startsWith('application/xhtml+xml'));
}

const bytesOf = (body: string, base64: boolean): Uint8Array =>
  base64
    ? Uint8Array.from(atob(body), (character) => character.charCodeAt(0))
    : new TextEncoder().encode(body);

/**
 * A `blob:` or `data:` download never touches the network, so no pause carried it. The page that
 * minted the URL can still read it: `fetch` in the page, base64 out, chunked so a large file does
 * not overflow `String.fromCharCode`'s argument list.
 */
export const blobReadExpression = (url: string): string =>
  `(async () => { const r = await fetch(${JSON.stringify(url)}); const b = new Uint8Array(await r.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768)); return btoa(s); })()`;

/** Insertion order is age, so the first key is the one to drop. */
const bounded = <T>(map: Map<string, T>, key: string, value: T): void => {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_HELD_DOWNLOADS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
};

export function downloadCatcher(init: {
  readonly page: CdpPageLike;
  readonly clock: SleepClock;
}): DownloadCatcher {
  const bodies = new Map<string, Uint8Array>();
  const ready: ScrapeDownloadFile[] = [];
  const finish = (file: ScrapeDownloadFile): void => {
    ready.push(file);
    if (ready.length > MAX_HELD_DOWNLOADS) ready.shift();
  };

  // Every failure below becomes NO file, and so `X_SCRAPE_DOWNLOAD_TIMEOUT` at the caller: these
  // run inside protocol event handlers, where a throw has no caller to reach and a floated
  // rejection is one Bun ends the process on.
  const begin = async (payload: unknown): Promise<void> => {
    const event = record(payload);
    const url = typeof event?.['url'] === 'string' ? event['url'] : '';
    const suggested = event?.['suggestedFilename'];
    const filename = typeof suggested === 'string' && suggested !== '' ? suggested : 'download';
    const captured = bodies.get(url);
    if (captured !== undefined) {
      bodies.delete(url);
      finish({ filename, bytes: captured });
      return;
    }
    if (!url.startsWith('blob:') && !url.startsWith('data:')) return;
    const encoded = await init.page.evaluate(blobReadExpression(url));
    if (typeof encoded === 'string') finish({ filename, bytes: bytesOf(encoded, true) });
  };

  return {
    async capture(paused, session): Promise<void> {
      const event = record(paused);
      const request = record(event?.['request']);
      const status = event?.['responseStatusCode'];
      if (typeof status !== 'number' || typeof request?.['url'] !== 'string') return;
      if (!downloadCandidate(status, event?.['responseHeaders'])) return;
      const url = request['url'];
      try {
        const answer = record(
          await session.send('Fetch.getResponseBody', { requestId: event?.['requestId'] }),
        );
        if (typeof answer?.['body'] !== 'string') return;
        bounded(bodies, url, bytesOf(answer['body'], answer['base64Encoded'] === true));
      } catch {
        // A body the browser would not hand over is a download this driver cannot answer; the
        // response is still released by the caller, so the page itself is unaffected.
      }
    },
    async arm(session): Promise<void> {
      session.on('Browser.downloadWillBegin', (payload) => {
        begin(payload).catch(() => undefined);
      });
      // `deny`: the bytes are already ours from the pause, so Chrome writing a second copy to a
      // directory on the browser's machine buys nothing — and on a launched worker it is a file
      // per download nobody deletes. `eventsEnabled` is what makes `downloadWillBegin` fire.
      await session.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
    },
    async next(timeoutMs, url): Promise<ScrapeDownloadFile> {
      const budget = deadline(init.clock, timeoutMs, 'page.download()');
      for (;;) {
        const file = ready.shift();
        if (file !== undefined) return file;
        if (budget.expired()) throw downloadTimeout(timeoutMs, url);
        await init.clock.sleep(Math.min(POLL_MS, budget.remainingMs()));
      }
    },
  };
}
