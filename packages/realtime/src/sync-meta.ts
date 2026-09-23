// The page's sync target, read off the `<meta>` tags the document shell renders — the default
// when the island bootstrap passed none. The names are core's (`page-meta.ts`): one literal per
// fact, written by `@ultimat3/render`, read here.

import { CLIENT_BUILD_META, CLIENT_SYNC_META, CLIENT_SYNC_WORKER_META } from '@ultimat3/core/page';
import type { SyncTarget } from './page-store';

/** The minimum of a DOM this reads — so a test can hand one in without a browser. */
export interface MetaDocument {
  querySelector(selector: string): { getAttribute(name: string): string | null } | null;
}

function meta(doc: MetaDocument, name: string): string | undefined {
  const content = doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content');
  return content === null || content === undefined || content === '' ? undefined : content;
}

/**
 * `ultimate-sync` resolved against the page (`/_x/sync` is same-origin), with the scheme turned
 * to the socket's: `https:` → `wss:`, `http:` → `ws:`; an absolute `ws(s)://` stays as written.
 * `undefined` when the document names no sync node — a page with no realtime.
 */
export function syncTargetFromMeta(doc: MetaDocument, href: string): SyncTarget | undefined {
  const sync = meta(doc, CLIENT_SYNC_META);
  if (sync === undefined) return undefined;
  const url = new URL(sync, href);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  return { url: url.toString(), buildId: meta(doc, CLIENT_BUILD_META) ?? '' };
}

/** The worker script URL, or `undefined` when the app built none (the in-page host is used). */
export function syncWorkerFromMeta(doc: MetaDocument, href: string): string | undefined {
  const worker = meta(doc, CLIENT_SYNC_WORKER_META);
  return worker === undefined ? undefined : new URL(worker, href).toString();
}

/** This page's target, when there is a page to read. */
export function pageSyncTarget(): SyncTarget | undefined {
  if (typeof document === 'undefined' || typeof location === 'undefined') return undefined;
  return syncTargetFromMeta(document, location.href);
}
