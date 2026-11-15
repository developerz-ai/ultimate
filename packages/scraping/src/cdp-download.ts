// The browser driver's `download()`: the file's bytes taken off the WIRE — the browser-level
// `Fetch` pause at the Response stage — never out of a download directory, which on
// `remoteBrowser()` is somebody else's disk. `Browser.downloadWillBegin` names the file.
//
// Measured on Chrome 157 (2026-11-15): the pause hands over the body before Chrome decides to
// download, and the event follows with the URL and the suggested name. Every read is byte-capped
// (`cdp-download-read.ts`): a scraped page chooses what it serves.

import type { SleepClock } from '@ultimat3/core';
import { finiteCount } from '@ultimat3/core';
import { DEFAULT_MAX_DOWNLOAD_BYTES, readCapped } from './cdp-download-read';
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
   * `true` when it released the response itself (`cdp-download-read.ts`).
   */
  capture(paused: unknown, session: CdpSessionLike): Promise<boolean>;
  /** Subscribes to the browser's download events, and turns Chrome's own write to disk off. */
  arm(session: CdpBrowserSessionLike): Promise<void>;
  /**
   * A TRIGGER happened — a click, a key, a navigation (`cdp-target.ts`). Every file that began
   * before it is dropped: it belongs to an earlier trigger nobody asked about, or to a `download()`
   * that already timed out, and handing it to this one is an answer off by one from then on.
   */
  mark(): void;
  /**
   * The NEWEST file begun since the last trigger, every older one cleared — the file the last
   * click produced, the same answer the offline drivers give — or `X_SCRAPE_DOWNLOAD_TIMEOUT`.
   */
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
 * `url` as a JavaScript string literal. The page minted it, so it is the page's text: JSON's
 * escaping plus `<` and the two line separators, which are the characters a literal pasted into
 * code may not carry raw — each can only sit inside the string, so `\u` always means an escape.
 */
const literalOf = (text: string): string =>
  JSON.stringify(text)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');

/**
 * A `blob:` or `data:` download never touches the network, so no pause carried it. The page that
 * minted the URL can still read it: `fetch` in the page, base64 out, chunked so a large file does
 * not overflow `String.fromCharCode`'s argument list. Its size is read BEFORE its bytes, and one
 * over the cap answers `null` — the page's own memory, never the worker's, holds it.
 */
export const blobReadExpression = (url: string, maxBytes: number): string =>
  `(async () => { const r = await fetch(${literalOf(url)}); const blob = await r.blob(); if (blob.size > ${String(maxBytes)}) return null; const b = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768)); return btoa(s); })()`;

/**
 * Insertion order is age, so the first key is the one to drop: at most `MAX_HELD_DOWNLOADS`
 * bodies, and at most `maxBytes` of them together — so the worst a page can make this hold is
 * one cap's worth, however many non-page documents it loads.
 */
const held = (map: Map<string, Uint8Array>, key: string, value: Uint8Array, maxBytes: number) => {
  map.delete(key);
  map.set(key, value);
  let total = 0;
  for (const bytes of map.values()) total += bytes.length;
  for (const [oldest, bytes] of map) {
    if (map.size <= MAX_HELD_DOWNLOADS && total <= maxBytes) break;
    map.delete(oldest);
    total -= bytes.length;
  }
};

export function downloadCatcher(init: {
  readonly page: CdpPageLike;
  readonly clock: SleepClock;
  /** `BrowserOptions.maxDownloadBytes`; `DEFAULT_MAX_DOWNLOAD_BYTES` when absent. */
  readonly maxBytes?: number | undefined;
}): DownloadCatcher {
  // Screened: `NaN` is not nullish, and a `NaN` cap compares false both ways — every body read.
  const maxBytes = finiteCount(
    'localBrowser()',
    'maxDownloadBytes',
    init.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES,
    1,
  );
  const bodies = new Map<string, Uint8Array>();
  // One counter orders triggers and download starts: a file's stamp is taken when Chrome says it
  // BEGAN, never when its bytes are in hand — a blob read finishes later, and its trigger is the
  // one before the begin.
  let sequence = 0;
  let trigger = 0;
  const ready: { readonly stamp: number; readonly file: ScrapeDownloadFile }[] = [];
  const finish = (stamp: number, file: ScrapeDownloadFile): void => {
    if (stamp < trigger) return;
    ready.push({ stamp, file });
    if (ready.length > MAX_HELD_DOWNLOADS) ready.shift();
  };

  // Every failure below becomes NO file, and so `X_SCRAPE_DOWNLOAD_TIMEOUT` at the caller: these
  // run inside protocol event handlers, where a throw has no caller to reach and a floated
  // rejection is one Bun ends the process on.
  const begin = async (payload: unknown): Promise<void> => {
    const stamp = ++sequence;
    const event = record(payload);
    const url = typeof event?.['url'] === 'string' ? event['url'] : '';
    const suggested = event?.['suggestedFilename'];
    const filename = typeof suggested === 'string' && suggested !== '' ? suggested : 'download';
    const captured = bodies.get(url);
    if (captured !== undefined) {
      bodies.delete(url);
      finish(stamp, { filename, bytes: captured });
      return;
    }
    if (!url.startsWith('blob:') && !url.startsWith('data:')) return;
    const encoded = await init.page.evaluate(blobReadExpression(url, maxBytes));
    if (typeof encoded === 'string') finish(stamp, { filename, bytes: bytesOf(encoded, true) });
  };

  return {
    async capture(paused, session): Promise<boolean> {
      const event = record(paused);
      const request = record(event?.['request']);
      const status = event?.['responseStatusCode'];
      const requestId = event?.['requestId'];
      const headers = event?.['responseHeaders'];
      if (typeof status !== 'number' || typeof request?.['url'] !== 'string') return false;
      if (typeof requestId !== 'string' || !downloadCandidate(status, headers)) return false;
      const url = request['url'];
      const length = Number(headerOf(headers, 'content-length') || Number.NaN);
      const read = await readCapped(
        session,
        {
          requestId,
          status,
          headers: Array.isArray(headers) ? headers : [],
          declaredLength: Number.isFinite(length) && length >= 0 ? length : undefined,
          attachment: headerOf(headers, 'content-disposition')
            .toLowerCase()
            .startsWith('attachment'),
        },
        maxBytes,
        (body) => held(bodies, url, body, maxBytes),
      );
      return read.released;
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
    mark(): void {
      trigger = ++sequence;
      ready.length = 0;
    },
    async next(timeoutMs, url): Promise<ScrapeDownloadFile> {
      const budget = deadline(init.clock, timeoutMs, 'page.download()');
      for (;;) {
        // Newest wins and the rest are cleared, so a second `download()` with no new trigger
        // waits for a new file rather than answering with a stale sibling.
        const newest = ready.at(-1);
        ready.length = 0;
        if (newest !== undefined) return newest.file;
        if (budget.expired()) throw downloadTimeout(timeoutMs, url);
        await init.clock.sleep(Math.min(POLL_MS, budget.remainingMs()));
      }
    },
  };
}
