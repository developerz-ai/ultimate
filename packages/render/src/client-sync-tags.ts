/**
 * The page's sync target as `<head>` tags, read by `@ultimat3/realtime`'s tab-side socket host:
 * where the one socket dials, which build the page was rendered by, and which worker script hosts
 * the socket. Principal-free, so a shareable document may carry them — unlike the scope tag.
 */

import { CLIENT_BUILD_META, CLIENT_SYNC_META, CLIENT_SYNC_WORKER_META } from '@ultimat3/core';
import type { HeadTag } from './head';

/** Core's names (`page-meta.ts`), so the writer here and every reader share one literal each. */
export { CLIENT_BUILD_META, CLIENT_SYNC_META, CLIENT_SYNC_WORKER_META };

export interface ClientSyncHead {
  readonly syncUrl: string;
  readonly buildId: string;
  readonly workerUrl?: string | undefined;
  /** `/_x/page-boot/<hash>.js` — realtime's page boot, when the app has realtime. */
  readonly bootUrl?: string | undefined;
}

export function clientSyncTags(head: ClientSyncHead): readonly HeadTag[] {
  return [
    meta(CLIENT_SYNC_META, head.syncUrl),
    meta(CLIENT_BUILD_META, head.buildId),
    ...(head.workerUrl === undefined ? [] : [meta(CLIENT_SYNC_WORKER_META, head.workerUrl)]),
  ];
}

const meta = (name: string, content: string): HeadTag => ({
  kind: 'meta',
  key: `meta:${name}`,
  attrs: { name, content },
});

/**
 * The page boot as one deferred classic script: it runs before every island module that follows it
 * in the document, and ONCE per page — the disk restore and the outbox are the page's job, never
 * each island's. Rendered only where there is a principal to restore for (`dev-render.ts`).
 */
export function clientBootTags(head: ClientSyncHead): readonly HeadTag[] {
  return head.bootUrl === undefined
    ? []
    : [{ kind: 'script', key: 'script:ultimate-boot', attrs: { src: head.bootUrl, defer: true } }];
}
