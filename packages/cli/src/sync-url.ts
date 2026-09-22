// Where a page's one socket dials — the framework's answer, so no app owns a `sync-url.ts`. Read
// once at boot from the deployment's env and handed to every document as `ultimate-sync`.

import { ConfigInvalidError } from '@ultimat3/core';

/**
 * The sync node's own path (`createSyncNode`'s default in `@ultimat3/realtime`). Same origin by
 * default because every rung already serves it there: `x dev` and a combined-role container mount
 * the node on the web port, and `docker/helm`'s ingress routes `/_x/sync` to the `sync` service.
 */
export const SYNC_PATH = '/_x/sync';

/**
 * `SYNC_URL` verbatim when the deployment states one — the Compose rung publishes `sync` on its
 * own port with no proxy in front, so only the deployment knows that URL — else `SYNC_PATH`,
 * resolved by the browser against its own origin. Never derived from a port: behind any ingress a
 * neighbouring port is a URL nothing publishes.
 */
export function syncUrlFrom(env: Readonly<Record<string, string | undefined>>): string {
  const declared = env['SYNC_URL']?.trim() ?? '';
  if (declared === '') return SYNC_PATH;
  const parsed = URL.parse(declared);
  if (parsed === null || (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')) {
    throw new ConfigInvalidError({
      cause: 'SYNC_URL is set but is not a ws:// or wss:// URL, so no browser could dial it',
      fix: 'export SYNC_URL="wss://sync.example.com/_x/sync"   # or unset it to dial /_x/sync on the page origin',
      meta: { key: 'SYNC_URL' },
    });
  }
  return declared;
}
